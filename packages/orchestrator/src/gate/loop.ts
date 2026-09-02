// The review-and-gate poll loop: watches open PRs on configured repos that
// this process did not create, drives one independent-vendor Reviewer,
// posts its review verbatim, and squash-merges once the gate says
// `mergeable` — only when merging is explicitly enabled. Dry run (the
// default) never calls GitAdapter.mergePR.

import type { GitAdapter, PRDetails, Reviewer } from '@floor-agents/core'
import { decideGate, isVerdictCurrentForHead, type GateDecision } from './decision.ts'
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

/** Has `vendor` already posted a verdict comment that is current for this
 *  head? Used to avoid re-reviewing the same head twice, independent of
 *  whether that verdict was itself an approval — a "changes needed" review
 *  still counts as "already reviewed this head". Identity comes from
 *  `trustedReviewers[comment.author]`, the same rule decideGate() uses —
 *  an untrusted author's comment never counts, even if it claims to be
 *  from `vendor` in its header. */
function hasVendorReviewedHead(
  comments: readonly { author: string; body: string; createdAt: Date }[],
  vendor: string,
  headSha: string,
  headCommitDate: Date,
  trustedReviewers: Readonly<Record<string, string>>,
): boolean {
  return comments.some(c => {
    const parsed = parseVerdictComment(c.body)
    if (!parsed) return false
    const trustedVendor = trustedReviewers[c.author.toLowerCase()]
    if (!trustedVendor || trustedVendor.toLowerCase() !== vendor.toLowerCase()) return false
    return isVerdictCurrentForHead(parsed.shas, c.createdAt, headSha, headCommitDate)
  })
}

async function processPR(repo: string, pr: PRDetails, deps: GateLoopDeps): Promise<void> {
  const log = deps.log ?? console.log
  const { git, reviewer, gateStateStore, config } = deps

  const implementerVendor = attributeImplementerVendor(
    { headRef: pr.headRef, body: pr.body, labels: pr.labels },
    config.vendor,
  )

  // decideGate() checks the draft flag and the needs-human label before it
  // ever looks at comments/checks/commit-date, so a PR we already know will
  // just "hold" skips those GitHub API calls entirely.
  const skipFetch = pr.draft || pr.labels.includes(config.gate.needsHumanLabel)

  const [comments, checkStatus, headCommitDate] = skipFetch
    ? [[] as { body: string; author: string; id: string; createdAt: Date }[], 'pending' as const, new Date(0)]
    : await Promise.all([
        git.listComments(repo, pr.id),
        git.getCheckStatus(repo, pr.headSha),
        git.getCommitDate(repo, pr.headSha),
      ])

  const decision = decideGate({
    pr: { labels: pr.labels, draft: pr.draft, headSha: pr.headSha, body: pr.body },
    implementerVendor,
    headCommitDate,
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

  if (decision.kind === 'needs_review') {
    if (reviewer.vendor.toLowerCase() === implementerVendor.toLowerCase()) {
      log(`[gate] ${repo}#${pr.id}: skipping review — configured reviewer vendor "${reviewer.vendor}" matches the implementer`)
    } else if (hasVendorReviewedHead(comments, reviewer.vendor, pr.headSha, headCommitDate, config.gate.trustedReviewers)) {
      log(`[gate] ${repo}#${pr.id}: reviewer "${reviewer.vendor}" already reviewed head ${pr.headSha.slice(0, 7)}`)
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
      // Posted verbatim — never edited, summarized, or re-wrapped.
      await git.addPRComment(repo, pr.id, result.text)
      log(`[gate] ${repo}#${pr.id}: posted ${reviewer.vendor} review for head ${pr.headSha.slice(0, 7)}`)
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
 *  is called. On a 403/429 from the GitAdapter, doubles the delay before
 *  the next pass (capped at 30 minutes) instead of hammering the API;
 *  a successful pass resets the delay back to the configured interval. */
export function startGateLoop(deps: GateLoopDeps): GateLoopHandle {
  const log = deps.log ?? console.log
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  async function tick(): Promise<void> {
    if (stopped) return

    let delay = deps.config.pollIntervalMs
    try {
      await runGatePass(deps)
    } catch (err) {
      if (isRateLimitError(err)) {
        delay = Math.min(deps.config.pollIntervalMs * 2, MAX_BACKOFF_MS)
        log(`[gate] rate limited, backing off to ${delay}ms: ${(err as Error).message}`)
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
