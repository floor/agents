/**
 * Turning verdicts into a decision, by policy.
 *
 * Pure: the caller collects the verdicts (an agent that timed out or failed
 * is passed as `abstain` with no blockers) and acts on the outcome. Nothing
 * here reads the manifest or talks to an adapter.
 */

import type { DecisionKind, DecisionPolicy } from '../types/decisions.ts'
import { resolveQuorum } from './policy.ts'

export type Verdict = {
  readonly agent: string
  readonly decision: 'approve' | 'changes' | 'abstain'
  readonly blockers: readonly string[]
  readonly confidence?: number
  readonly summary?: string
}

export type HumanVerdict = {
  readonly id: string
  readonly decision: 'approve' | 'changes'
}

export type DecisionInput = {
  readonly kind: DecisionKind
  readonly policy: DecisionPolicy
  /** The team's verdicts. The lead's belongs in `lead`, not here. */
  readonly verdicts: readonly Verdict[]
  readonly lead?: Verdict
  readonly human?: HumanVerdict
}

export type DecisionResult = 'approve' | 'changes' | 'no-decision' | 'needs-human'

export type DecisionOutcome = {
  readonly result: DecisionResult
  readonly decidedBy: 'lead' | 'team' | 'human' | 'none'
  readonly reason: string
  /** Every blocker raised, once each, in order: what the revision prompt is given. */
  readonly blockers: readonly string[]
}

function unionBlockers(verdicts: readonly Verdict[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of verdicts) {
    for (const b of v.blockers) {
      if (seen.has(b)) continue
      seen.add(b)
      out.push(b)
    }
  }
  return out
}

/** The verdicts that count: those of the policy's voters, when it names them. */
function seated(policy: DecisionPolicy, verdicts: readonly Verdict[]): readonly Verdict[] {
  if (!policy.voters) return verdicts
  const voters = new Set(policy.voters)
  return verdicts.filter(v => voters.has(v.agent))
}

function byLead(lead: Verdict | undefined, blockers: string[]): DecisionOutcome {
  if (!lead) return { result: 'no-decision', decidedBy: 'none', reason: 'No lead verdict', blockers }
  if (lead.decision === 'abstain') return { result: 'no-decision', decidedBy: 'none', reason: `The lead (${lead.agent}) abstained`, blockers }
  return {
    result: lead.decision,
    decidedBy: 'lead',
    reason: `The lead (${lead.agent}) ${lead.decision === 'approve' ? 'approved' : 'requested changes'}`,
    blockers,
  }
}

function byHuman(input: DecisionInput): DecisionOutcome {
  const blockers = unionBlockers(input.lead ? [input.lead, ...input.verdicts] : input.verdicts)
  const { human, policy } = input
  if (!human) return { result: 'needs-human', decidedBy: 'none', reason: 'A person decides; none has yet', blockers }
  if (policy.humans && !policy.humans.includes(human.id)) {
    return { result: 'needs-human', decidedBy: 'none', reason: `${human.id} may not decide ${input.kind}`, blockers }
  }
  return {
    result: human.decision,
    decidedBy: 'human',
    reason: `${human.id} ${human.decision === 'approve' ? 'approved' : 'requested changes'}`,
    blockers,
  }
}

function byTeam(input: DecisionInput): DecisionOutcome {
  const { policy } = input
  const verdicts = seated(policy, input.verdicts)
  const blockers = unionBlockers(verdicts)
  const cast = verdicts.filter(v => v.decision !== 'abstain')
  const quorum = resolveQuorum(policy)
  if (cast.length < quorum) {
    return { result: 'no-decision', decidedBy: 'none', reason: `${cast.length} of ${quorum} verdicts needed`, blockers }
  }

  const approvals = cast.filter(v => v.decision === 'approve').length
  const changes = cast.length - approvals
  const tally = `${approvals} approve, ${changes} changes`
  const decided = (approve: boolean, why: string): DecisionOutcome =>
    ({ result: approve ? 'approve' : 'changes', decidedBy: 'team', reason: `${why} (${tally})`, blockers })

  switch (policy.mode) {
    case 'majority':
      // Strict: a tie does not approve.
      return decided(approvals > changes, approvals > changes ? 'Majority approved' : 'No majority to approve')
    case 'unanimous':
      return decided(changes === 0, changes === 0 ? 'Unanimous approval' : 'Not unanimous')
    default: {
      // veto. Any blocker stops an approval — also one from a finished review
      // whose vote was not recognised: it is in `verdicts` as an abstention
      // with blockers. A seat that failed is passed with none.
      const majority = approvals > changes
      if (majority && blockers.length === 0) return decided(true, 'Majority approved, no blockers')
      return decided(false, majority ? `Vetoed by ${blockers.length} blocker(s)` : 'No majority to approve')
    }
  }
}

/** The outcome of one decision under its policy. */
export function decide(input: DecisionInput): DecisionOutcome {
  switch (input.policy.mode) {
    case 'lead':
      // Team verdicts are ignored: the lead's blockers are the only ones reported.
      return byLead(input.lead, input.lead ? unionBlockers([input.lead]) : [])
    case 'lead-with-advisors': {
      // The lead saw the advisors' blockers; they are reported, and do not override.
      const advisors = seated(input.policy, input.verdicts)
      return byLead(input.lead, unionBlockers(input.lead ? [input.lead, ...advisors] : advisors))
    }
    case 'human':
      return byHuman(input)
    case 'majority':
    case 'unanimous':
    case 'veto':
      return byTeam(input)
    default:
      return { result: 'no-decision', decidedBy: 'none', reason: `Unknown decision mode: ${String(input.policy.mode)}`, blockers: [] }
  }
}
