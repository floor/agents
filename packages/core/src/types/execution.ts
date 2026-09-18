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
  /** Every gate invocation this run, failed and flaky attempts included. */
  readonly gateRuns?: readonly GateRun[]
  /** Repair turns already used in the current implementer turn. */
  readonly fixTurnsUsed?: number
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
}

export type CommandResult = {
  readonly name: string
  readonly command: readonly string[]
  readonly exitCode: number
  readonly timedOut: boolean
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  /** Last 32,768 characters of stdout, even when the head was truncated. */
  readonly stdoutTail?: string
  /** Last 32,768 characters of stderr, even when the head was truncated. */
  readonly stderrTail?: string
  readonly truncated?: boolean
  /** The process never started (sandbox refused, spawn threw) — not a command exit. */
  readonly failedToStart?: boolean
  readonly flaky?: boolean
  /**
   * Whether this attempt counts toward the command's result. A discarded
   * flaky failure is `false`; omitted means accepted (older state files).
   */
  readonly accepted?: boolean
}

export type VerificationResult = {
  readonly passed: boolean
  readonly treeSha: string
  readonly commitSha?: string
  readonly checkedAt: string
  readonly durationMs?: number
  readonly checks: readonly CommandResult[]
  readonly error?: string
}

/** One invocation of the full verification gate. */
export type GateRun = {
  readonly startedAt: string
  readonly durationMs: number
  readonly passed: boolean
  readonly treeSha: string
  readonly checks: readonly CommandResult[]
  readonly error?: string
}

export type StateStore = {
  get(issueId: string): Promise<ExecutionState | null>
  save(state: ExecutionState): Promise<void>
  list(): Promise<readonly ExecutionState[]>
}
