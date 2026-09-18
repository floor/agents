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
  | 'review_rfc'
  | 'vote'

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
  /**
   * How long one turn of this agent may run, in milliseconds.
   *
   * A native CLI turn is one call that reads, edits and runs tests until it is
   * done, so the budget is the task's size, not the engine's. The default suits
   * a small fix; a project raises it for an agent that works on more.
   */
  readonly timeoutMs?: number
  /**
   * How many tool calls one turn may make, for a CLI that counts them
   * (claude-code). The default fits the role: an implementer edits, runs tests
   * and iterates, a reviewer reads. A turn that reaches the cap ends with no
   * result, so the cap is a size of task, like timeoutMs.
   */
  readonly maxTurns?: number
  readonly external?: boolean
  /**
   * External only: vote by posting on the issue instead of a CLI bridge.
   * Absent or false means the engine starts the agent's bridge (or abstains
   * immediately if that fails). Comment polling is never the default.
   */
  readonly voteByComment?: boolean
}
