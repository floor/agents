import type { AgentDefinition } from './agent.ts'
import type { AutonomyConfig } from './autonomy.ts'
import type { ChainOfCommand } from './chain.ts'
import type { CostConfig } from './costs.ts'
import type { DecisionsConfig, HumansConfig, RolesConfig } from './decisions.ts'
import type { GuardrailsConfig } from './guardrails.ts'
import type { ProjectConfig } from './project.ts'
import type { ReviewConfig } from './review.ts'
import type { SourceDefinition } from './sources.ts'
import type { TasksConfig } from './tasks.ts'
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
  /** Named sources beside the repository, by key. */
  readonly sources?: Readonly<Record<string, SourceDefinition>>
  /** Where this project's tasks live; absent means GitHub issues in the project's repository. */
  readonly tasks?: TasksConfig
  /**
   * How implementer PRs are reviewed. Absent means committee review when no
   * `review_pr` agent is seated, and the single-reviewer path when one is.
   */
  readonly review?: ReviewConfig
  /**
   * Who decides what, by kind of decision. The loader always fills in
   * `pr-review` and `rfc` (today's rules) when the manifest does not name them.
   */
  readonly decisions?: DecisionsConfig
  /** Seats: the lead, implementers and reviewers, by agent id. */
  readonly roles?: RolesConfig
  /** The people who may decide, and what each may do. */
  readonly humans?: HumansConfig
  readonly costs: CostConfig
  readonly statusMapping: Record<string, string>
  readonly createdAt: Date
  readonly updatedAt: Date
}
