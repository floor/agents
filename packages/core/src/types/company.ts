import type { AgentDefinition } from './agent.ts'
import type { AutonomyConfig } from './autonomy.ts'
import type { ChainOfCommand } from './chain.ts'
import type { CostConfig } from './costs.ts'
import type { GuardrailsConfig } from './guardrails.ts'
import type { ProjectConfig } from './project.ts'
import type { WorkflowDefinition } from './workflow.ts'

export type CompanyConfig = {
  readonly id: string
  readonly name: string
  readonly project: ProjectConfig
  readonly agents: readonly AgentDefinition[]
  readonly workflow: WorkflowDefinition
  readonly chain: ChainOfCommand
  readonly autonomy: AutonomyConfig
  readonly guardrails: GuardrailsConfig
  readonly costs: CostConfig
  readonly statusMapping: Record<string, string>
  readonly createdAt: Date
  readonly updatedAt: Date
}
