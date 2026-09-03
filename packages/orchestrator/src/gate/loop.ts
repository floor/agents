// The review-and-gate poll loop: watches open PRs on configured repos that
// this process did not create, drives one independent-vendor Reviewer,
// posts its review verbatim, and squash-merges once the gate says
// `mergeable` — only when merging is explicitly enabled. Dry run (the
// default) never calls GitAdapter.mergePR.

import type { GitAdapter, PRDetails, Reviewer } from '@floor-agents/core'
import { decideGate, latestValidVerdictsByVendor, type GateDecision } from './decision.ts'
import { parseVerdictComment, type Decision as VerdictDecision } from './verdict.ts'
import { attributeImplementerVendor } from './vendor.ts'
import { buildReviewPrompt, extractChangedFiles } from './prompt.ts'
import { selectChecklistFiles, loadChecklists, NO_CHECKLIST_TEXT } from './checklists.ts'
import type { GateStateStore } from './state-store.ts'
import type { GateModeConfig } from './config.ts'

export type GateLoopDeps = {
  readonly git: GitAdapter
  readonly reviewer: Reviewer
  /** A second, independent-vendor `Reviewer`, run in addition to `reviewer`
   *  on any PR carrying a `config.gate.authLabels` label (see
   *  `config.gate.secondReviewer` for the vendor name this should be built
   *  from, and processPR below for the scheduling rule) — so an
   *  auth-sensitive PR can collect the two independent-vendor
   *  `approve as-is` verdicts the auth gate requires without a human
   *  triggering the second review by hand. Optional; when unset, only
   *  `reviewer` ever runs automatically, same as before this existed. */
  readonly secondReviewer?: Reviewer
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
  const { git, reviewer, secondReviewer, gateStateStore, config } = deps

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

  // Saves the current in-memory state immediately — called at each point
  // below where a crash or a thrown error must not lose durability, not
  // just once at the end of the function.
  async function persist(): Promise<void> {
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

  // Calls `rv` to review the current head, unless its vendor matches the
  // implementer or it was already asked to review this exact head (per the
  // durable `reviewedHeads` mark, not a live-comment scan — see
  // `hasVendorReviewedHead`'s own doc comment). Shared by the default
  // gate's single-reviewer `needs_review` handling below and the
  // auth-labelled-PR scheduling further down, so both paths post/log/mark
  // identically instead of drifting apart. Returns the posted verdict's
  // decision (or `null` when nothing was posted — skipped, or malformed
  // output) so a caller scheduling more than one reviewer in the same pass
  // can react to what this one just found, not just what was already on
  // the PR before this pass started.
  async function tryReview(rv: Reviewer): Promise<VerdictDecision | null> {
    if (rv.vendor.toLowerCase() === implementerVendor.toLowerCase()) {
      log(`[gate] ${repo}#${pr.id}: skipping review — configured reviewer vendor "${rv.vendor}" matches the implementer`)
      return null
    }
    if (hasVendorReviewedHead(reviewedHeads, pr.headSha, rv.vendor)) {
      log(`[gate] ${repo}#${pr.id}: reviewer "${rv.vendor}" was already asked to review head ${pr.headSha.slice(0, 7)}`)
      return null
    }

    const diff = await git.getPRDiff(repo, pr.id)
    const changedFiles = extractChangedFiles(diff)
    const template = deps.loadPromptTemplate
      ? await deps.loadPromptTemplate()
      : await defaultLoadPromptTemplate(config.promptTemplatePath)

    // Resolves, fresh right here (never a value carried over from the
    // pass's earlier listOpenPRs() call), both:
    //  (a) the merge-base of pr.baseRef and pr.headSha — the correct diff
    //      base, handed to the prompt as {{mergeBase}} below. NEVER
    //      pr.baseSha: that's the base branch's tip as of PR
    //      creation/last-sync, and once the base branch has advanced past
    //      where this PR forked off, diffing against it (or an even
    //      staler recorded value) pulls in every commit merged into the
    //      base branch since, making them look like part of the PR (see
    //      floor/radiooooo PR #130, which got a false scope finding from
    //      exactly this).
    //  (b) the base branch's CURRENT tip — used only below to fetch
    //      checklist CONTENT from a ref outside the PR's control, never
    //      the PR's own head (see gate/checklists.ts's header comment for
    //      the full rationale). This is deliberately not the same value
    //      as (a): a checklist should read the base branch's latest, not
    //      freeze at the PR's fork point.
    const compareResult = await git.compare(repo, pr.baseRef, pr.headSha)
    if (!compareResult) {
      log(`[gate] ${repo}#${pr.id}: could not resolve merge base (compare ${pr.baseRef}...${pr.headSha.slice(0, 7)} failed) — {{mergeBase}} left unresolved this pass`)
    }

    // Checklist files are selected from config (label/path rules); their
    // CONTENT is fetched at the base branch's current tip, from (a) above
    // when it resolved, or pr.baseSha (the PR's own recorded value, which
    // can lag but is still outside the PR's control) when compare()
    // failed. Skip checklists entirely (not merely "getFile returns
    // null" — never even attempt a fetch) if NEITHER resolves; DO NOT
    // fall back to pr.headSha as a substitute ref under any circumstance.
    const checklistFiles = selectChecklistFiles(config.checklists.rules, { labels: pr.labels, changedFiles })
    let checklists = NO_CHECKLIST_TEXT
    if (checklistFiles.length > 0) {
      const checklistRef = compareResult?.baseSha || pr.baseSha || null
      if (!checklistRef) {
        log(`[gate] ${repo}#${pr.id}: could not resolve any base ref for checklists (compare failed and PR has no recorded baseSha) — skipping checklists this pass, not falling back to head`)
      } else {
        checklists = await loadChecklists(git, repo, checklistRef, checklistFiles, log)
      }
    }

    const prompt = buildReviewPrompt(template, {
      repo,
      prNumber: pr.id,
      title: pr.title,
      body: pr.body,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      headSha: pr.headSha,
      changedFiles,
      checklists,
      mergeBase: compareResult?.mergeBaseSha,
    })

    // Mark (and durably persist) the attempt BEFORE calling the
    // reviewer — a thrown Reviewer.review() call, or a crash mid-call,
    // must still leave this head recorded as attempted on disk, not
    // only in memory pending a save that never happens.
    reviewedHeads = withReviewedHead(reviewedHeads, pr.headSha, rv.vendor)
    await persist()

    const result = await rv.review({ repo, prNumber: pr.id, headSha: pr.headSha, prompt })
    const parsed = parseVerdictComment(result.text)

    if (!parsed) {
      log(`[gate] ${repo}#${pr.id}: reviewer "${rv.vendor}" returned malformed output for head ${pr.headSha.slice(0, 7)} (no valid header/verdict line) — not posted`)
      return null
    }

    // Posted verbatim — never edited, summarized, or re-wrapped.
    await git.addPRComment(repo, pr.id, result.text)
    log(`[gate] ${repo}#${pr.id}: posted ${rv.vendor} review for head ${pr.headSha.slice(0, 7)}`)
    return parsed.decision
  }

  if (decision.kind === 'needs_review') {
    await tryReview(reviewer)
  } else if (decision.kind !== 'mergeable' && !skipFetch && config.gate.authLabels.some(l => pr.labels.includes(l))) {
    // decideGate()'s auth gate always returns `blocked` (never
    // `needs_review`), even with zero verdicts yet — see the "Known
    // limitation" section of docs/review-gate.md and decision.ts's own
    // rule table, which this deliberately leaves UNCHANGED. This loop
    // closes that gap for itself instead: an auth-labelled PR still needs
    // its reviews triggered somehow, so both the primary `reviewer` and,
    // if configured, `secondReviewer` are asked here, in addition to (not
    // instead of) the decision table above. Explicitly excludes
    // `decision.kind === 'mergeable'` — a PR already fully approved and
    // green has nothing left to trigger, and calling a reviewer again there
    // (however harmlessly `tryReview`'s own dedup would make it) would be
    // pure waste. The merge/hold/blocked handling below is otherwise
    // unaffected by any of this.
    //
    // Skipped when there's already a blocking verdict (`changes needed` /
    // `approve with nits`) from a trusted vendor for this exact head — same
    // as the default gate, that means a human/fix is needed, not another
    // review round. `tryReview` itself also short-circuits cheaply (before
    // ever fetching the diff) for a vendor already asked about this head,
    // so calling it here even when nothing is actually needed costs at
    // most a wasted function call, never a wasted API call.
    const hasBlockingVerdict = latestValidVerdictsByVendor(
      {
        pr: { labels: pr.labels, draft: pr.draft, headSha: pr.headSha, body: pr.body },
        implementerVendor,
        checkStatus,
        comments,
        config: config.gate,
      },
      config.gate,
    ).some(v => v.decision === 'changes needed' || v.decision === 'approve with nits')

    if (!hasBlockingVerdict) {
      // `hasBlockingVerdict` above only reflects comments fetched BEFORE
      // this pass called anything — if the primary reviewer's OWN verdict,
      // just posted, is itself blocking, that must stop the second
      // reviewer from running in this SAME pass too (it would otherwise
      // review a PR the primary just said needs changes, in the same
      // breath as posting that verdict). `tryReview`'s return value is
      // this pass's own knowledge of what the primary just found — more
      // immediate than waiting for the next pass to re-fetch comments and
      // recompute `hasBlockingVerdict` from them.
      const primaryDecision = await tryReview(reviewer)
      const primaryIsBlocking = primaryDecision === 'changes needed' || primaryDecision === 'approve with nits'
      if (secondReviewer && !primaryIsBlocking) await tryReview(secondReviewer)
    }
  }

  if (decision.kind === 'mergeable') {
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
      // Persist immediately — a crash between mergePR() returning and the
      // end-of-pass save (below) would otherwise leave `merged: false` on
      // disk even though GitHub already merged and closed the PR. The
      // remaining, unavoidable window (a crash between GitHub applying
      // the merge and this save call returning) is documented in
      // docs/known-issues.md; recovery is that the next pass sees the PR
      // missing from listOpenPRs() (GitHub only returns open PRs) and
      // simply stops touching it, merged flag or not.
      await persist()
      log(`[gate] ${repo}#${pr.id}: merged head ${pr.headSha.slice(0, 7)}`)
    }
  }
  // 'hold' and 'blocked': no action beyond the log line above and persisting state below.

  await persist()
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
