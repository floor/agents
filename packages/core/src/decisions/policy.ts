import type { DecisionKind, DecisionMode, DecisionPolicy, DecisionsConfig, HumanPermission } from '../types/decisions.ts'

export const DECISION_MODES: readonly DecisionMode[] = ['lead', 'lead-with-advisors', 'majority', 'unanimous', 'veto', 'human']
export const HUMAN_PERMISSIONS: readonly HumanPermission[] = ['assign-lead', 'override', 'publish']

/** Non-abstaining verdicts a team mode needs when the policy names none: a lone reviewer is not a committee. */
export const DEFAULT_QUORUM = 2
/** Review cycles before a person is asked; the engine's `MAX_REVIEW_CYCLES`. */
export const DEFAULT_ROUNDS = 3

/**
 * Today's rules, as policies. A PR needs two votes, a strict majority and no
 * blocker from anyone (`tallyCommitteePrReview`); an RFC needs a strict
 * majority of whoever voted, one vote being enough (`tallyVotes`).
 */
export const DEFAULT_DECISIONS: DecisionsConfig = {
  'pr-review': { mode: 'veto', quorum: 2, rounds: 3 },
  'rfc': { mode: 'majority', quorum: 1 },
}

/** The policy for a kind: the manifest's, else the default, else none. */
export function decisionPolicy(kind: DecisionKind, decisions?: DecisionsConfig): DecisionPolicy | undefined {
  return decisions?.[kind] ?? DEFAULT_DECISIONS[kind]
}

export function resolveQuorum(policy: DecisionPolicy): number {
  return policy.quorum ?? DEFAULT_QUORUM
}

/** Most rounds a decision may take before a person is asked. */
export function resolveRounds(policy: DecisionPolicy): number {
  return policy.rounds ?? DEFAULT_ROUNDS
}
