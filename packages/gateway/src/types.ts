// ── Agent Gateway Protocol Types ────────────────────────────────

export type AgentChannel = 'websocket' | 'poll'

export type AgentRegistration = {
  readonly agentId: string
  readonly name: string
  readonly capabilities: readonly string[]
  readonly channel: AgentChannel
}

// Server → Agent messages
export type ServerMessage =
  | { readonly type: 'welcome'; readonly agentId: string }
  | { readonly type: 'assignment'; readonly task: TaskAssignment }
  | { readonly type: 'assignment_cancelled'; readonly taskId: string; readonly reason: string }
  | { readonly type: 'heartbeat' }
  | { readonly type: 'error'; readonly message: string }

// Agent → Server messages
export type AgentMessage =
  | { readonly type: 'register'; readonly agentId: string; readonly name: string; readonly capabilities: readonly string[] }
  | { readonly type: 'result'; readonly taskId: string; readonly content: string }
  | { readonly type: 'heartbeat' }

export type TaskAssignment = {
  readonly id: string
  readonly issueId: string
  readonly title: string
  readonly body: string
  readonly systemPrompt: string
  readonly createdAt: string
}

export type TaskResult = {
  readonly taskId: string
  readonly agentId: string
  readonly content: string
  readonly receivedAt: Date
}

export type ConnectedAgent = {
  readonly agentId: string
  readonly name: string
  readonly capabilities: readonly string[]
  readonly channel: AgentChannel
  readonly connectedAt: Date
  readonly ws?: unknown
}
