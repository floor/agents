export type ExecutionStep =
  | 'pending'
  | 'building_context'
  | 'calling_llm'
  | 'parsing_output'
  | 'validating_output'
  | 'creating_branch'
  | 'committing_files'
  | 'creating_pr'
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

export type ExecutionState = {
  readonly issueId: string
  readonly agentId: string
  readonly step: ExecutionStep
  readonly startedAt: string
  readonly branchName: string | null
  readonly commitSha: string | null
  readonly prUrl: string | null
  readonly llmResponse: string | null
  readonly parsedOutput: AgentOutput | null
  readonly costUsd: number
  readonly error: string | null
  readonly updatedAt: string
}

export type StateStore = {
  get(issueId: string): Promise<ExecutionState | null>
  save(state: ExecutionState): Promise<void>
  list(): Promise<readonly ExecutionState[]>
}
