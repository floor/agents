// Pure gate decision function for the review-and-gate loop. No I/O: every
// input is data the loop already fetched. See docs/review-gate.md for the
// full rule table and the independent-review protocol it implements.

import type { CheckStatus } from '@floor-agents/core'
import { parseVerdictComment, type Decision as VerdictDecision } from './verdict.ts'

export type GateDecision =
  | { readonly kind: 'hold'; readonly reason: string }
  | { readonly kind: 'needs_review'; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'mergeable' }

export type GateConfig = {
  /** Labels that put a PR on the stronger auth review gate. Default: ['auth']. */
  readonly authLabels: readonly string[]
  /** Label that unconditionally holds a PR for a human. Default: 'needs-human'. */
  readonly needsHumanLabel: string
  /** GitHub comment-author login (lowercased) -> vendor, OR -> an array of
   *  vendors when a single posting identity legitimately posts reviews for
   *  more than one (e.g. the gate loop's own bot account, running both a
   *  primary and a `secondReviewer` under one `GITHUB_TOKEN`). A verdict
   *  comment only counts if its AUTHOR is a key here.
   *
   *  - String value: the vendor used for every gating rule
   *    (differs-from-implementer, latest-per-vendor, the auth gate's
   *    two-distinct-vendor count) is this mapped vendor UNCONDITIONALLY —
   *    never the free-text vendor name the comment's own header claims.
   *  - Array value: the vendor comes from the comment's own header text
   *    instead, but ONLY when that header names one of the vendors this
   *    login is listed for (case-insensitive) — a header naming anything
   *    else is rejected outright, not attributed to the first entry or any
   *    other default. This is what lets one posting identity be trusted
   *    for multiple vendors without letting it (or anyone impersonating
   *    its comments) claim an arbitrary vendor by simply writing a
   *    different header.
   *
   *  Either way, the header is formatting, not an identity on its own:
   *  without an entry here, anyone who can comment on the PR (including its
   *  own author) could post `## Reviewer agent (Codex)` /
   *  `Verdict: approve as-is` and satisfy the gate. Include the gate loop's
   *  own posting identity here, mapped to its configured Reviewer's vendor
   *  (and its `secondReviewer`'s vendor too, as an array, if one is
   *  configured) — otherwise a posted review never counts as a verdict,
   *  nothing merges, and every PR stays at `needs_review`/`blocked` after
   *  one attempted review (`reviewedHeads` persistence prevents a repeat
   *  review; it does not make the verdict count).
   *  Default `{}` is fail-closed: no comment is trusted until configured. */
  readonly trustedReviewers: Readonly<Record<string, string | readonly string[]>>
  /** Vendor name of a second `Reviewer` the gate loop should also run, in
   *  addition to the primary, on any PR carrying an `authLabels` label —
   *  so an auth-sensitive PR can collect the two independent-vendor
   *  `approve as-is` verdicts the auth gate below requires without a human
   *  or a separate process triggering the second review by hand. Optional;
   *  unset means only the primary reviewer ever runs automatically. This
   *  is loop scheduling, not a gating rule: it never changes what
   *  `decideGate` itself decides (see `packages/orchestrator/src/gate/loop.ts`). */
  readonly secondReviewer?: string
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  authLabels: ['auth'],
  needsHumanLabel: 'needs-human',
  trustedReviewers: {},
}

export type GateDecisionPR = {
  readonly labels: readonly string[]
  readonly draft: boolean
  readonly headSha: string
  readonly body: string
}

export type GateDecisionComment = {
  /** GitHub comment id, as returned by the API. Used only to break a
   *  same-timestamp tie between two comments (GitHub ids are monotonically
   *  increasing, so a larger id is strictly later even when createdAt
   *  reads identical to the second). */
  readonly id: string
  /** GitHub login of the comment's author, as returned by the API — not
   *  anything the comment body itself claims. */
  readonly author: string
  readonly body: string
  readonly createdAt: Date
}

export type GateDecisionInput = {
  readonly pr: GateDecisionPR
  readonly implementerVendor: string
  readonly checkStatus: CheckStatus
  readonly comments: readonly GateDecisionComment[]
  readonly config?: GateConfig
}

const RUNTIME_SIGN_IN_CHECK_RE = /runtime sign-in check/i

export type ValidVerdict = {
  readonly vendor: string
  readonly decision: VerdictDecision
  readonly id: string
  readonly createdAt: Date
}

/** A verdict names the given head only if one of its extracted shas is a
 *  prefix match (full or abbreviated) for that head's sha. A verdict that
 *  names no sha, or names a different sha, does NOT count — there is no
 *  date-based fallback: a force-push to an older commit can never inherit
 *  an approval that never named a sha, however recently it was posted.
 *  Exported for the gate loop's own "has this vendor already reviewed the
 *  head?" dedup check, which needs the same rule but not the
 *  vendor-differs-from-implementer half of validity. */
export function verdictNamesHead(shas: readonly string[], headSha: string): boolean {
  return shas.some(sha => headSha.toLowerCase().startsWith(sha))
}

/** A verdict comment is valid for gating only if its vendor differs from
 *  the implementer, and it names the head (see above). */
function isValidForHead(
  vendor: string,
  shas: readonly string[],
  implementerVendor: string,
  headSha: string,
): boolean {
  if (vendor.toLowerCase() === implementerVendor.toLowerCase()) return false
  return verdictNamesHead(shas, headSha)
}

/** Orders two comments by createdAt, breaking a tie by numeric comment id
 *  (GitHub ids are monotonically increasing, so this is a reliable
 *  same-second tiebreaker). Positive when `a` is later than `b`. */
function compareCommentOrder(a: { id: string; createdAt: Date }, b: { id: string; createdAt: Date }): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime()
  if (byTime !== 0) return byTime
  const an = Number(a.id)
  const bn = Number(b.id)
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Resolves the trusted vendor for a comment from `config.trustedReviewers`,
 *  given its author and the vendor name its own header claims. Returns
 *  `null` when the comment does not count as a verdict from ANY vendor:
 *
 *  - The author isn't a key in `trustedReviewers` at all.
 *  - The author is trusted for multiple vendors (an array value) but the
 *    header names something outside that list — this is what stops a
 *    spoofed header from claiming a DIFFERENT vendor than the one that
 *    actually posted, even from an otherwise-trusted multi-vendor login.
 *
 *  A string value is returned unconditionally — the mapped vendor, never
 *  whatever the header itself claims (see `GateConfig.trustedReviewers`). */
function resolveTrustedVendor(config: GateConfig, author: string, headerVendor: string): string | null {
  const allowed = config.trustedReviewers[author.toLowerCase()]
  if (allowed === undefined) return null

  if (typeof allowed === 'string') return allowed

  const headerVendorLower = headerVendor.toLowerCase()
  return allowed.find(vendor => vendor.toLowerCase() === headerVendorLower) ?? null
}

/** Latest valid verdict per vendor (by createdAt, then comment id to break
 *  a same-second tie), keyed case-insensitively. The vendor identity comes
 *  from `resolveTrustedVendor` (author identity, plus the header only when
 *  the author is trusted for more than one vendor) — never from the
 *  comment's own header text alone — so an untrusted author's comment, or
 *  a trusted-but-out-of-list header claim, is skipped entirely, regardless
 *  of how well-formed it looks. Exported for the gate loop's own auth-PR
 *  review-scheduling logic, which needs the same "is there already a
 *  blocking verdict for this head?" answer `decideGate` computes, without
 *  duplicating this resolution logic. */
export function latestValidVerdictsByVendor(input: GateDecisionInput, config: GateConfig): ValidVerdict[] {
  const byVendor = new Map<string, ValidVerdict>()

  for (const comment of input.comments) {
    const parsed = parseVerdictComment(comment.body)
    if (!parsed) continue

    const trustedVendor = resolveTrustedVendor(config, comment.author, parsed.vendor)
    if (!trustedVendor) continue

    if (!isValidForHead(trustedVendor, parsed.shas, input.implementerVendor, input.pr.headSha)) continue

    const key = trustedVendor.toLowerCase()
    const existing = byVendor.get(key)
    if (!existing || compareCommentOrder(comment, existing) > 0) {
      byVendor.set(key, { vendor: trustedVendor, decision: parsed.decision, id: comment.id, createdAt: comment.createdAt })
    }
  }

  return [...byVendor.values()]
}

export function decideGate(input: GateDecisionInput): GateDecision {
  const config = input.config ?? DEFAULT_GATE_CONFIG
  const { pr, checkStatus } = input

  if (pr.labels.includes(config.needsHumanLabel)) {
    return { kind: 'hold', reason: `has the "${config.needsHumanLabel}" label` }
  }
  if (pr.draft) {
    return { kind: 'hold', reason: 'PR is a draft' }
  }

  const verdicts = latestValidVerdictsByVendor(input, config)

  const blocking = verdicts.find(v => v.decision === 'changes needed' || v.decision === 'approve with nits')
  if (blocking) {
    return { kind: 'blocked', reason: `${blocking.vendor} verdict on this head: ${blocking.decision}` }
  }

  const approvals = verdicts.filter(v => v.decision === 'approve as-is')
  const isAuth = config.authLabels.some(l => pr.labels.includes(l))

  if (isAuth) {
    const distinctVendors = new Set(approvals.map(v => v.vendor.toLowerCase()))
    const hasTwoVendors = distinctVendors.size >= 2
    const hasRuntimeCheck = RUNTIME_SIGN_IN_CHECK_RE.test(pr.body)

    if (!hasTwoVendors && !hasRuntimeCheck) {
      return {
        kind: 'blocked',
        reason: 'auth gate: needs two independent approve-as-is verdicts (has ' +
          `${distinctVendors.size}) and a "runtime sign-in check" section in the PR body (missing)`,
      }
    }
    if (!hasTwoVendors) {
      return {
        kind: 'blocked',
        reason: `auth gate: needs a second independent approve-as-is verdict (has ${distinctVendors.size})`,
      }
    }
    if (!hasRuntimeCheck) {
      return { kind: 'blocked', reason: 'auth gate: PR body is missing a "runtime sign-in check" section' }
    }

    if (checkStatus === 'pending') return { kind: 'hold', reason: 'checks pending' }
    if (checkStatus === 'failure') return { kind: 'blocked', reason: 'checks failing' }
    return { kind: 'mergeable' }
  }

  // Default gate (also covers `structural`-labeled PRs: same rule, per protocol).
  if (approvals.length === 0) {
    return { kind: 'needs_review', reason: 'no valid approve-as-is verdict yet' }
  }
  if (checkStatus === 'pending') return { kind: 'hold', reason: 'checks pending' }
  if (checkStatus === 'failure') return { kind: 'blocked', reason: 'checks failing' }
  return { kind: 'mergeable' }
}
