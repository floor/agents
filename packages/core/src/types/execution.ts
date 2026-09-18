export type ExecutionStep =
  | 'pending'
  | 'building_context'
  | 'calling_llm'
  | 'parsing_output'
  | 'validating_output'
  | 'creating_branch'
  | 'committing_files'
  | 'creating_pr'
  | 'reviewing'
  | 'revision'
  | 'updating_issue'
  | 'done'
  | 'failed'

export type FileOutput = {
  readonly path: string
  readonly content: string
}

export type AgentOutput = {
  readonly rawResponse: string
  readonly files: readonly FileOutput[]
  readonly prDescription: string
  readonly parseErrors: readonly string[]
}

export type ReviewVerdict = {
  readonly decision: 'approve' | 'request_changes'
  readonly comments: string
}

export type ExecutionState = {
  readonly workspacePath?: string
  readonly baseSha?: string
  readonly verification?: VerificationResult
  readonly issueId: string
  readonly agentId: string
  readonly step: ExecutionStep
  readonly startedAt: string
  readonly branchName: string | null
  readonly commitSha: string | null
  readonly prUrl: string | null
  readonly prId: string | null
  readonly llmResponse: string | null
  readonly parsedOutput: AgentOutput | null
  readonly reviewVerdict: ReviewVerdict | null
  readonly reviewCycle: number
  readonly costUsd: number
  readonly error: string | null
  readonly updatedAt: string
  /** Append-only: every implementer turn of this issue, across retries. */
  readonly attempts?: readonly Attempt[]
  /** Append-only: every review cycle, across retries. */
  readonly reviews?: readonly ReviewRecord[]
}

export type CommandResult = {
  readonly name: string
  readonly command: readonly string[]
  readonly exitCode: number
  readonly timedOut: boolean
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
}

export type VerificationResult = {
  readonly passed: boolean
  readonly treeSha: string
  readonly commitSha?: string
  readonly checkedAt: string
  readonly checks: readonly CommandResult[]
  readonly error?: string
}

/** One run of the gate on an attempt's tree. Outputs are kept for the checks that failed, as tails. */
export type GateRun = {
  readonly at: string
  readonly treeSha: string
  readonly passed: boolean
  readonly durationMs: number
  readonly checks: readonly {
    readonly name: string
    readonly exitCode: number
    readonly timedOut: boolean
    readonly durationMs: number
    /** Last lines of stdout and stderr — only for a check that did not pass. */
    readonly tail?: string
  }[]
  readonly error?: string
}

/** How an implementer turn ended. */
export type AttemptOutcome =
  | 'running'
  | 'published'     // verified, committed, pushed
  | 'stopped'       // the turn ran out of a budget or the CLI failed
  | 'no-changes'    // the turn ended with an empty diff
  | 'guardrail'     // the change broke a guardrail
  | 'gate-failed'   // a verification command failed
  | 'error'         // anything else

/**
 * One implementer turn and what became of its tree.
 *
 * The state used to be a cursor: one record per issue, overwritten as the run
 * advanced and archived whole by a retry, so a finished tree that failed the
 * gate by five bytes existed only as an unnamed directory. An attempt names it.
 */
export type Attempt = {
  readonly n: number
  readonly kind: 'implement' | 'revision'
  readonly agentId: string
  readonly model: string
  readonly startedAt: string
  readonly endedAt?: string
  /** The CLI turn alone, without setup and gate. */
  readonly turnMs?: number
  readonly baseSha: string
  /** The branch tip the worktree was created at — the parent of the commit this attempt publishes. */
  readonly initialSha?: string
  /** The worktree, for as long as it is preserved; cleared once the attempt is published. */
  readonly worktreePath?: string
  readonly exitCode?: number
  readonly subtype?: string
  /** The agent CLI's process, while the turn runs: what a restart ends if a crash left it behind. */
  readonly pid?: number
  /** The CLI's own session, when it names one: what a revision resumes instead of starting over. */
  readonly sessionId?: string
  /** The attempt whose session this turn continued. */
  readonly continues?: number
  /** The first characters of the agent's reply — what it said it did. */
  readonly reply?: string
  readonly gates: readonly GateRun[]
  readonly outcome: AttemptOutcome
  readonly commitSha?: string
  readonly error?: string
}

/** One review cycle on a pull request. */
export type ReviewRecord = {
  readonly cycle: number
  readonly at: string
  readonly commitSha: string | null
  readonly durationMs: number
  readonly votes: readonly {
    readonly agentId: string; readonly agentName: string; readonly vote: string; readonly execution?: string
    /** The `BLOCKER:` lines this member wrote — what the next cycle is compared with. */
    readonly blockers?: readonly string[]
  }[]
  readonly outcome: string
  readonly blockers?: string
  /** Blockers a member repeated after a revision: the review loop stopped on them for a person. */
  readonly standing?: readonly string[]
}

export type StateStore = {
  get(issueId: string): Promise<ExecutionState | null>
  save(state: ExecutionState): Promise<void>
  list(): Promise<readonly ExecutionState[]>
}
