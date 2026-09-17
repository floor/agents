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

export type StateStore = {
  get(issueId: string): Promise<ExecutionState | null>
  save(state: ExecutionState): Promise<void>
  list(): Promise<readonly ExecutionState[]>
}
