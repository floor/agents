// ── Agent Gateway Protocol Types ────────────────────────────────

export type AgentChannel = 'websocket' | 'poll'

// ── Validation ──────────────────────────────────────────────────

const VALID_AGENT_MSG_TYPES = new Set(['register', 'result', 'heartbeat'])

export function validateAgentMessage(data: unknown): data is AgentMessage {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  if (typeof obj.type !== 'string' || !VALID_AGENT_MSG_TYPES.has(obj.type)) return false

  switch (obj.type) {
    case 'register':
      return typeof obj.agentId === 'string' && obj.agentId.length > 0
        && typeof obj.name === 'string' && obj.name.length > 0
        && Array.isArray(obj.capabilities)
        && (obj.capabilities as unknown[]).every(c => typeof c === 'string')
    case 'result':
      return typeof obj.taskId === 'string' && obj.taskId.length > 0
        && typeof obj.content === 'string'
    case 'heartbeat':
      return true
    default:
      return false
  }
}

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
