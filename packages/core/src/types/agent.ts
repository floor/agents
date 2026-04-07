export type AgentCapability =
  | 'read_code'
  | 'write_code'
  | 'create_pr'
  | 'review_pr'
  | 'write_tests'
  | 'decompose_task'
  | 'manage_issues'
  | 'approve'
  | 'reject'

export type AutonomyTier = 'T1' | 'T2' | 'T3'

export type AgentLLMConfig = {
  readonly provider: string
  readonly model: string
  readonly temperature: number
  readonly maxTokens: number
}

export type AgentDefinition = {
  readonly id: string
  readonly name: string
  readonly promptTemplate: string
  readonly llm: AgentLLMConfig
  readonly capabilities: readonly AgentCapability[]
  readonly autonomy: AutonomyTier
  readonly customInstructions: string
}
