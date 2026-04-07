import type {
  WorkflowDefinition,
  WorkflowStateDefinition,
  TransitionDefinition,
  TransitionTrigger,
  AgentDefinition,
  TaskAdapter,
  IssueStatus,
  Issue,
} from '@floor-agents/core'

// Maps workflow state IDs to IssueStatus values (1:1 for all standard states)
const WORKFLOW_STATE_TO_STATUS: Readonly<Record<string, IssueStatus>> = {
  backlog: 'backlog',
  triage: 'triage',
  in_progress: 'in_progress',
  in_review: 'in_review',
  changes_requested: 'changes_requested',
  qa: 'qa',
  done: 'done',
}

export type WorkflowEngineDeps = {
  readonly workflow: WorkflowDefinition
  readonly agents: readonly AgentDefinition[]
  readonly taskAdapter: TaskAdapter
}

export class WorkflowEngine {
  private readonly stateById: ReadonlyMap<string, WorkflowStateDefinition>
  private readonly transitions: readonly TransitionDefinition[]
  private readonly agentById: ReadonlyMap<string, AgentDefinition>
  private readonly taskAdapter: TaskAdapter
  // In-memory cycle counts — keyed by `issueId:from->to`
  private readonly cycleCounts = new Map<string, number>()

  constructor(deps: WorkflowEngineDeps) {
    this.stateById = new Map(deps.workflow.states.map(s => [s.id, s]))
    this.transitions = deps.workflow.transitions
    this.agentById = new Map(deps.agents.map(a => [a.id, a]))
    this.taskAdapter = deps.taskAdapter
  }

  getState(stateId: string): WorkflowStateDefinition | undefined {
    return this.stateById.get(stateId)
  }

  /** Find the first transition from `fromStateId` whose trigger matches `trigger`. */
  findTransition(fromStateId: string, trigger: TransitionTrigger): TransitionDefinition | null {
    return (
      this.transitions.find(t => t.from === fromStateId && this.triggerMatches(t.trigger, trigger)) ??
      null
    )
  }

  private triggerMatches(def: TransitionTrigger, actual: TransitionTrigger): boolean {
    if (def.type !== actual.type) return false
    if (def.type === 'label_added' && actual.type === 'label_added') {
      return def.label === actual.label
    }
    if (def.type === 'label_removed' && actual.type === 'label_removed') {
      return def.label === actual.label
    }
    if (def.type === 'custom' && actual.type === 'custom') {
      return def.event === actual.event
    }
    return true
  }

  resolveAgent(agentId: string): AgentDefinition | undefined {
    return this.agentById.get(agentId)
  }

  /**
   * Advance an issue to `toStateId` by setting its status in the task manager.
   * States without a direct IssueStatus mapping (e.g. `needs_human`) are silently
   * skipped — callers should handle those via `setLabel`.
   */
  async advanceToState(issueId: string, toStateId: string): Promise<void> {
    const status = WORKFLOW_STATE_TO_STATUS[toStateId]
    if (status) {
      await this.taskAdapter.setStatus(issueId, status)
    }
  }

  /**
   * Derive the workflow state ID from the issue's current status.
   * IssueStatus values match workflow state IDs in the default config.
   */
  resolveWorkflowStateId(issue: Issue): string {
    return issue.status
  }

  /** Collect all label values used in `label_added` triggers across all transitions. */
  getLabelTriggers(): string[] {
    const labels = new Set<string>()
    for (const t of this.transitions) {
      if (t.trigger.type === 'label_added') {
        labels.add(t.trigger.label)
      }
    }
    return [...labels]
  }

  /**
   * Returns the agentId configured for the `in_progress → in_review` transition.
   * This is the agent that should review code (typically the CTO).
   */
  getReviewerAgentId(): string | null {
    const t = this.transitions.find(t => t.from === 'in_progress' && t.to === 'in_review')
    return t?.agentId ?? null
  }

  /**
   * Returns the `in_review → changes_requested` transition.
   * Used to read `maxCycles` and `fallbackState` for the review loop.
   */
  getChangesTransition(): TransitionDefinition | undefined {
    return this.transitions.find(t => t.from === 'in_review' && t.to === 'changes_requested')
  }

  incrementCycle(issueId: string, fromState: string, toState: string): number {
    const key = `${issueId}:${fromState}->${toState}`
    const next = (this.cycleCounts.get(key) ?? 0) + 1
    this.cycleCounts.set(key, next)
    return next
  }

  getCycles(issueId: string, fromState: string, toState: string): number {
    const key = `${issueId}:${fromState}->${toState}`
    return this.cycleCounts.get(key) ?? 0
  }
}
