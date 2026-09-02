// The review-and-gate poll loop: watches open PRs on configured repos that
// this process did not create, drives one independent-vendor Reviewer,
// posts its review verbatim, and squash-merges once the gate says
// `mergeable` — only when merging is explicitly enabled. Dry run (the
// default) never calls GitAdapter.mergePR.

import type { GitAdapter, PRDetails, Reviewer } from '@floor-agents/core'
import { decideGate, type GateDecision } from './decision.ts'
import { parseVerdictComment } from './verdict.ts'
import { attributeImplementerVendor } from './vendor.ts'
import { buildReviewPrompt, extractChangedFiles } from './prompt.ts'
import type { GateStateStore } from './state-store.ts'
import type { GateModeConfig } from './config.ts'

export type GateLoopDeps = {
  readonly git: GitAdapter
  readonly reviewer: Reviewer
  readonly gateStateStore: GateStateStore
  readonly config: GateModeConfig
  /** Injected for tests; defaults to console.log. */
  readonly log?: (line: string) => void
  /** Injected for tests; defaults to reading `config.promptTemplatePath`
   *  from disk on every call (cheap, and lets an operator edit the
   *  template without restarting the loop). */
  readonly loadPromptTemplate?: () => Promise<string>
}

function decisionReason(decision: GateDecision): string | null {
  return decision.kind === 'mergeable' ? null : decision.reason
}

function firstParagraph(body: string): string {
  return (body.trim().split(/\r?\n\s*\r?\n/)[0] ?? '').trim()
}

async function defaultLoadPromptTemplate(path: string): Promise<string> {
  const file = Bun.file(path)
  if (!await file.exists()) {
    throw new Error(`Review prompt template not found: ${path}`)
  }
  return file.text()
}

/** Adds `vendor` to the set of vendors that have reviewed `headSha`,
 *  returning a new reviewedHeads map (never mutates the input). */
function withReviewedHead(
  reviewedHeads: Readonly<Record<string, readonly string[]>>,
  headSha: string,
  vendor: string,
): Record<string, readonly string[]> {
  const existing = reviewedHeads[headSha] ?? []
  if (existing.some(v => v.toLowerCase() === vendor.toLowerCase())) return { ...reviewedHeads }
  return { ...reviewedHeads, [headSha]: [...existing, vendor] }
}

/** Has `vendor` already been asked to review `headSha`? This is deliberately
 *  based on PERSISTED loop state (`reviewedHeads`, recorded the moment
 *  Reviewer.review() was called), not on scanning live PR comments — a
 *  live-comment scan would be fooled by a comment later deleted, a
 *  reviewer response that failed to parse as a valid verdict, or a
 *  trustedReviewers mapping that changed after the fact, any of which
 *  would make the loop think "not yet reviewed" and call the reviewer
 *  again every single pass. */
function hasVendorReviewedHead(
  reviewedHeads: Readonly<Record<string, readonly string[]>>,
  headSha: string,
  vendor: string,
): boolean {
  return (reviewedHeads[headSha] ?? []).some(v => v.toLowerCase() === vendor.toLowerCase())
}

async function processPR(repo: string, pr: PRDetails, deps: GateLoopDeps): Promise<void> {
  const log = deps.log ?? console.log
  const { git, reviewer, gateStateStore, config } = deps

  const implementerVendor = attributeImplementerVendor(
    { headRef: pr.headRef, body: pr.body, labels: pr.labels },
    config.vendor,
  )

  // decideGate() checks the draft flag and the needs-human label before it
  // ever looks at comments/checks, so a PR we already know will just
  // "hold" skips those GitHub API calls entirely.
  const skipFetch = pr.draft || pr.labels.includes(config.gate.needsHumanLabel)

  const [comments, checkStatus] = skipFetch
    ? [[] as { id: string; body: string; author: string; createdAt: Date }[], 'pending' as const]
    : await Promise.all([
        git.listComments(repo, pr.id),
        git.getCheckStatus(repo, pr.headSha),
      ])

  const decision = decideGate({
    pr: { labels: pr.labels, draft: pr.draft, headSha: pr.headSha, body: pr.body },
    implementerVendor,
    checkStatus,
    comments,
    config: config.gate,
  })

  const prevState = await gateStateStore.get(repo, pr.id)
  const changed = !prevState || prevState.headSha !== pr.headSha || prevState.decisionKind !== decision.kind

  log(
    `[gate] ${repo}#${pr.id} head=${pr.headSha.slice(0, 7)} implementer=${implementerVendor} ` +
    `decision=${decision.kind}${decisionReason(decision) ? ` reason="${decisionReason(decision)}"` : ''}` +
    (changed ? ' (changed)' : ''),
  )

  let merged = prevState?.headSha === pr.headSha ? prevState.merged : false
  let reviewedHeads = prevState?.reviewedHeads ?? {}

  if (decision.kind === 'needs_review') {
    if (reviewer.vendor.toLowerCase() === implementerVendor.toLowerCase()) {
      log(`[gate] ${repo}#${pr.id}: skipping review — configured reviewer vendor "${reviewer.vendor}" matches the implementer`)
    } else if (hasVendorReviewedHead(reviewedHeads, pr.headSha, reviewer.vendor)) {
      log(`[gate] ${repo}#${pr.id}: reviewer "${reviewer.vendor}" was already asked to review head ${pr.headSha.slice(0, 7)}`)
    } else {
      const diff = await git.getPRDiff(repo, pr.id)
      const template = deps.loadPromptTemplate
        ? await deps.loadPromptTemplate()
        : await defaultLoadPromptTemplate(config.promptTemplatePath)

      const prompt = buildReviewPrompt(template, {
        repo,
        prNumber: pr.id,
        title: pr.title,
        body: pr.body,
        baseRef: pr.baseRef,
        headRef: pr.headRef,
        headSha: pr.headSha,
        changedFiles: extractChangedFiles(diff),
      })

      const result = await reviewer.review({ repo, prNumber: pr.id, headSha: pr.headSha, prompt })

      // Record the attempt regardless of outcome — a malformed response, a
      // comment later deleted, or a trustedReviewers mapping that changes
      // must never cause this same head to be re-reviewed every pass.
      reviewedHeads = withReviewedHead(reviewedHeads, pr.headSha, reviewer.vendor)

      if (!parseVerdictComment(result.text)) {
        log(`[gate] ${repo}#${pr.id}: reviewer "${reviewer.vendor}" returned malformed output for head ${pr.headSha.slice(0, 7)} (no valid header/verdict line) — not posted`)
      } else {
        // Posted verbatim — never edited, summarized, or re-wrapped.
        await git.addPRComment(repo, pr.id, result.text)
        log(`[gate] ${repo}#${pr.id}: posted ${reviewer.vendor} review for head ${pr.headSha.slice(0, 7)}`)
      }
    }
  } else if (decision.kind === 'mergeable') {
    if (!config.mergeEnabled) {
      log(`DRY RUN would merge #${pr.id} at ${pr.headSha}`)
    } else if (merged) {
      log(`[gate] ${repo}#${pr.id}: already merged head ${pr.headSha.slice(0, 7)}, skipping`)
    } else {
      await git.mergePR(repo, pr.id, {
        commitTitle: `${pr.title} (#${pr.id})`,
        commitMessage: firstParagraph(pr.body),
      })
      merged = true
      log(`[gate] ${repo}#${pr.id}: merged head ${pr.headSha.slice(0, 7)}`)
    }
  }
  // 'hold' and 'blocked': no action beyond the log line above and persisting state below.

  await gateStateStore.save({
    repo,
    prNumber: pr.id,
    headSha: pr.headSha,
    decisionKind: decision.kind,
    reason: decisionReason(decision),
    merged,
    reviewedHeads,
    updatedAt: new Date().toISOString(),
  })
}

/** Runs exactly one poll pass over every configured repo. Exported
 *  separately from the interval wrapper below so tests can drive it
 *  deterministically without real timers. */
export async function runGatePass(deps: GateLoopDeps): Promise<void> {
  const log = deps.log ?? console.log
  const excludeAuthors = new Set(deps.config.excludeAuthors.map(a => a.toLowerCase()))

  for (const repo of deps.config.repos) {
    const prs = await deps.git.listOpenPRs(repo)
    for (const pr of prs) {
      if (excludeAuthors.has(pr.authorLogin.toLowerCase())) {
        log(`[gate] ${repo}#${pr.id}: skipping — authored by excluded login "${pr.authorLogin}" (this process's own identity)`)
        continue
      }
      await processPR(repo, pr, deps)
    }
  }
}

export type GateLoopHandle = {
  stop(): void
}

const MAX_BACKOFF_MS = 30 * 60_000

function isRateLimitError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  return status === 403 || status === 429
}

/** Runs `runGatePass` on `config.pollIntervalMs`, forever, until `stop()`
 *  is called. On a 403/429 from the GitAdapter, the delay before the next
 *  pass compounds across CONSECUTIVE rate-limit failures — 2x, 4x, 8x, ...
 *  up to a 30-minute cap — rather than a flat one-time doubling, so a
 *  sustained rate limit actually backs off instead of retrying at the
 *  same doubled interval forever. A successful pass resets the streak
 *  (and the delay) back to the configured interval; a non-rate-limit
 *  failure does not reset it, since it says nothing about whether the
 *  rate limit has cleared. */
export function startGateLoop(deps: GateLoopDeps): GateLoopHandle {
  const log = deps.log ?? console.log
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let consecutiveRateLimitFailures = 0

  async function tick(): Promise<void> {
    if (stopped) return

    let delay = deps.config.pollIntervalMs
    try {
      await runGatePass(deps)
      consecutiveRateLimitFailures = 0
    } catch (err) {
      if (isRateLimitError(err)) {
        consecutiveRateLimitFailures++
        delay = Math.min(deps.config.pollIntervalMs * 2 ** consecutiveRateLimitFailures, MAX_BACKOFF_MS)
        log(`[gate] rate limited (${consecutiveRateLimitFailures} in a row), backing off to ${delay}ms: ${(err as Error).message}`)
      } else {
        log(`[gate] pass failed: ${(err as Error).message}`)
      }
    }

    if (!stopped) timer = setTimeout(tick, delay)
  }

  void tick()

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
