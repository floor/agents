/**
 * The project API, version 1: what an engine process tells a control panel.
 *
 * These shapes are the contract. They are what `docs/api.md` documents and what
 * a panel is written against; the engine's own records (`ExecutionState`) may
 * change shape without the API doing so. Everything here is read-only and JSON:
 * dates are ISO strings, durations are milliseconds.
 */

export const API_VERSION = 'v1'

/** How the engine process was started: only serving the API, or watching the task source too. */
export type EngineMode = 'serve' | 'watch'

export type ApiAgent = {
  readonly id: string
  readonly name: string
  /** What the agent is on this team, read from its capabilities. */
  readonly role: 'implementer' | 'reviewer' | 'committee member' | 'planner' | 'member'
  readonly provider: string
  readonly model: string
  /** True when it connects through the gateway (a CLI bridge) rather than being dispatched by the engine. */
  readonly external: boolean
  readonly capabilities: readonly string[]
}

export type ApiProject = {
  readonly name: string
  /** `owner/name` on the git platform. */
  readonly repo: string
  readonly baseBranch: string
  /** Where the project's tasks live: `linear`, `github-issues`, `things`. */
  readonly taskSource: string
  /** The labels that make the engine take an issue. */
  readonly triggerLabels: readonly string[]
  readonly engine: {
    readonly version: string
    readonly mode: EngineMode
    readonly pid: number
    readonly startedAt: string
    readonly api: typeof API_VERSION
  }
  readonly limits: {
    /** Tasks at once on this machine, across engine processes; 0 means no limit. */
    readonly maxRuns: number
    readonly maxReviewCycles: number
  }
  readonly team: readonly ApiAgent[]
}

/**
 * Where a run stands, in the words a list needs. `step` is the engine's precise
 * cursor; `phase` is what a person wants to know at a glance.
 */
export type RunPhase = 'working' | 'verifying' | 'reviewing' | 'revising' | 'done' | 'needs-person' | 'failed'

export type ApiVote = {
  readonly agent: string
  readonly vote: string
  /** True when the seat never answered (quota, crash, bridge): not a member abstaining. */
  readonly failed: boolean
}

export type ApiAttemptSummary = {
  readonly n: number
  readonly kind: 'implement' | 'revision'
  readonly agentId: string
  readonly model: string
  readonly outcome: string
  readonly turnMs: number | null
  /** The last gate run on this attempt's tree. */
  readonly gate: 'passed' | 'failed' | 'none'
  readonly gateMs: number | null
  /** The attempt whose CLI session this one continued. */
  readonly continues: number | null
  readonly commit: string | null
  readonly startedAt: string
  readonly endedAt: string | null
}

export type ApiReviewSummary = {
  readonly cycle: number
  readonly outcome: string
  readonly durationMs: number
  readonly votes: readonly ApiVote[]
  readonly at: string
}

export type ApiRunSummary = {
  readonly issueId: string
  readonly issueKey: string | null
  readonly issueTitle: string | null
  readonly step: string
  readonly phase: RunPhase
  /** First line of the error, for a run that stopped. */
  readonly error: string | null
  readonly agentId: string
  readonly branch: string | null
  readonly prUrl: string | null
  readonly attempts: number
  readonly lastAttempt: ApiAttemptSummary | null
  readonly reviews: number
  readonly lastReview: ApiReviewSummary | null
  readonly costUsd: number
  /** Turns, gates and reviews added up: the engine's working time, not the wall clock. */
  readonly workMs: number
  readonly startedAt: string
  readonly updatedAt: string
}

export type ApiCheck = {
  readonly name: string
  readonly passed: boolean
  readonly timedOut: boolean
  readonly durationMs: number
  /** The end of what a failing check printed. */
  readonly tail: string | null
}

export type ApiAttempt = ApiAttemptSummary & {
  /** What the agent said it did, shortened. */
  readonly reply: string | null
  readonly error: string | null
  /** Where the tree was kept, for an attempt that was not published. */
  readonly worktreePath: string | null
  readonly gates: readonly {
    readonly at: string
    readonly passed: boolean
    readonly durationMs: number
    readonly checks: readonly ApiCheck[]
    readonly error: string | null
  }[]
}

export type ApiReview = ApiReviewSummary & {
  readonly commit: string | null
  /** The blockers handed to the implementer, as one text. */
  readonly blockers: string | null
  /** Blockers a member repeated after a revision: why the loop stopped for a person. */
  readonly standing: readonly string[]
}

export type ApiRunDetail = ApiRunSummary & {
  readonly attemptList: readonly ApiAttempt[]
  readonly reviewList: readonly ApiReview[]
}

export type ApiIssue = {
  readonly id: string
  readonly key: string | null
  readonly title: string
  /** The engine's reading of the status: backlog, triage, in_progress, in_review, qa, done, changes_requested. */
  readonly status: string
  /** The task source's own name for it. */
  readonly stateName: string | null
  readonly milestone: string | null
  readonly priority: number | null
  readonly labels: readonly string[]
  readonly url: string | null
  /** True when it carries a trigger label: the engine takes it, or has. */
  readonly queued: boolean
  readonly updatedAt: string
  /** The issue's recorded run, when it has one. */
  readonly run: ApiRunSummary | null
}

export type ApiIssues = {
  readonly generatedAt: string
  /** `task-source` when the list came from it; `runs` when it could not be asked and only issues with a run are listed. */
  readonly source: 'task-source' | 'runs'
  /** Why the task source could not be asked, when `source` is `runs`. */
  readonly sourceError: string | null
  readonly issues: readonly ApiIssue[]
}

export type ApiRuns = {
  readonly generatedAt: string
  readonly runs: readonly ApiRunSummary[]
}

export type ApiError = { readonly error: string }
