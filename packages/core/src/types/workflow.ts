// Phase 1: defined only — loaded and validated but not executed

export type TransitionTrigger =
  | { readonly type: 'label_added'; readonly label: string }
  | { readonly type: 'label_removed'; readonly label: string }
  | { readonly type: 'agent_completed' }
  | { readonly type: 'review_approved' }
  | { readonly type: 'review_rejected' }
  | { readonly type: 'qa_passed' }
  | { readonly type: 'qa_failed' }
  | { readonly type: 'subtasks_created' }
  | { readonly type: 'subtask_unblocked' }
  | { readonly type: 'manual' }
  | { readonly type: 'custom'; readonly event: string }

export type WorkflowStateDefinition = {
  readonly id: string
  readonly label: string
  readonly taskManagerStatus: string
  readonly terminal: boolean
}

export type TransitionDefinition = {
  readonly from: string
  readonly to: string
  readonly trigger: TransitionTrigger
  readonly agentId: string | null
  readonly maxCycles?: number | null
  readonly fallbackState?: string | null
}

export type WorkflowDefinition = {
  readonly states: readonly WorkflowStateDefinition[]
  readonly transitions: readonly TransitionDefinition[]
}
