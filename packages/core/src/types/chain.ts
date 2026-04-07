// Phase 1: defined only — loaded and validated but not traversed

export type WorkSource =
  | { readonly type: 'trigger' }
  | { readonly type: 'agent'; readonly id: string }
  | { readonly type: 'workflow' }

export type ChainNode = {
  readonly agentId: string
  readonly receivesFrom: readonly WorkSource[]
  readonly dispatchesTo: readonly string[]
  readonly reportsTo: string | null
  readonly canApprove: boolean
  readonly canReject: boolean
}

export type ChainOfCommand = {
  readonly nodes: readonly ChainNode[]
}
