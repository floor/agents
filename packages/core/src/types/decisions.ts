/**
 * Who decides what, and by which rule.
 *
 * The engine used to hard-code its consensus rules: a PR needs two votes, a
 * strict majority and no blocker from anyone; an RFC needs a strict majority
 * of whoever voted. A manifest's `decisions:` block names a policy per kind of
 * decision instead. Absent, the defaults reproduce those rules exactly.
 */

/** The decisions the engine knows. Other strings are allowed so a manifest can name new ones. */
export type KnownDecisionKind = 'pr-review' | 'rfc' | 'merge' | 'publish' | 'gate-failure' | 'lead-assignment'
export type DecisionKind = KnownDecisionKind | (string & {})

export type DecisionMode = 'lead' | 'lead-with-advisors' | 'majority' | 'unanimous' | 'veto' | 'human'

export type DecisionPolicy = {
  readonly mode: DecisionMode
  /** Non-abstaining verdicts needed before the team can decide. Default 2. Team modes only. */
  readonly quorum?: number
  /** How long a seat is given before it counts as an abstention. */
  readonly timeoutMs?: number
  /** Most rounds (review cycles) before a person is asked. Default 3. */
  readonly rounds?: number
  /** Agent ids whose verdicts count; absent means every verdict passed in. */
  readonly voters?: readonly string[]
  /** For `human` mode: who may decide; ids from the manifest's `humans` block. Absent means anyone. */
  readonly humans?: readonly string[]
}

export type DecisionsConfig = Readonly<Record<string, DecisionPolicy>>

/** Seats in the team. Ids refer to `agents`. */
export type RolesConfig = {
  readonly lead?: string
  readonly implementers?: readonly string[]
  readonly reviewers?: readonly string[]
}

export type HumanPermission = 'assign-lead' | 'override' | 'publish'

export type HumanDefinition = {
  readonly can: readonly HumanPermission[]
}

export type HumansConfig = Readonly<Record<string, HumanDefinition>>
