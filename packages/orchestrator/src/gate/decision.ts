// Pure gate decision function for the review-and-gate loop. No I/O: every
// input is data the loop already fetched. See docs/review-gate.md for the
// full rule table and the protocol it implements
// (floor/radiooooo AGENTS.md, "Review" section).

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
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  authLabels: ['auth'],
  needsHumanLabel: 'needs-human',
}

export type GateDecisionPR = {
  readonly labels: readonly string[]
  readonly draft: boolean
  readonly headSha: string
  readonly body: string
}

export type GateDecisionComment = {
  readonly body: string
  readonly createdAt: Date
}

export type GateDecisionInput = {
  readonly pr: GateDecisionPR
  readonly implementerVendor: string
  /** The head commit's own date (author/committer date on GitHub) — used
   *  to decide whether a sha-less verdict still covers the current head. */
  readonly headCommitDate: Date
  readonly checkStatus: CheckStatus
  readonly comments: readonly GateDecisionComment[]
  readonly config?: GateConfig
}

const RUNTIME_SIGN_IN_CHECK_RE = /runtime sign-in check/i

type ValidVerdict = {
  readonly vendor: string
  readonly decision: VerdictDecision
  readonly createdAt: Date
}

/** A verdict comment is valid for the given head only if its vendor
 *  differs from the implementer, and either it names the head sha or (it
 *  names no sha at all and was posted after the head commit was made). */
function isValidForHead(
  vendor: string,
  shas: readonly string[],
  createdAt: Date,
  implementerVendor: string,
  headSha: string,
  headCommitDate: Date,
): boolean {
  if (vendor.toLowerCase() === implementerVendor.toLowerCase()) return false

  const namesHead = shas.some(sha => headSha.toLowerCase().startsWith(sha))
  if (namesHead) return true
  if (shas.length === 0 && createdAt.getTime() > headCommitDate.getTime()) return true
  return false
}

/** Latest valid verdict per vendor (by createdAt), keyed case-insensitively
 *  but reported with the vendor's own casing from its most recent verdict. */
function latestValidVerdictsByVendor(input: GateDecisionInput): ValidVerdict[] {
  const byVendor = new Map<string, ValidVerdict>()

  for (const comment of input.comments) {
    const parsed = parseVerdictComment(comment.body)
    if (!parsed) continue

    if (!isValidForHead(
      parsed.vendor,
      parsed.shas,
      comment.createdAt,
      input.implementerVendor,
      input.pr.headSha,
      input.headCommitDate,
    )) continue

    const key = parsed.vendor.toLowerCase()
    const existing = byVendor.get(key)
    if (!existing || comment.createdAt.getTime() > existing.createdAt.getTime()) {
      byVendor.set(key, { vendor: parsed.vendor, decision: parsed.decision, createdAt: comment.createdAt })
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

  const verdicts = latestValidVerdictsByVendor(input)

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
