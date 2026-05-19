import type {
  AgentMessage,
  ServerMessage,
  ConnectedAgent,
  TaskAssignment,
  TaskResult,
} from './types.ts'

export type GatewayConfig = {
  readonly port: number
  readonly heartbeatIntervalMs?: number
  readonly taskTimeoutMs?: number
}

export type Gateway = {
  start(): void
  stop(): void
  assign(agentId: string, task: TaskAssignment): void
  waitForResult(taskId: string, timeoutMs?: number): Promise<TaskResult>
  getConnectedAgents(): readonly ConnectedAgent[]
  isAgentConnected(agentId: string): boolean
  onAgentConnect(handler: (agent: ConnectedAgent) => void): void
  onAgentDisconnect(handler: (agentId: string) => void): void
}

const DEFAULT_HEARTBEAT_MS = 30_000
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000

type WS = { send(data: string): void }

type PendingResult = {
  resolve: (result: TaskResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type PendingTask = { agentId: string; task: TaskAssignment }

type GatewayState = {
  agents: Map<string, ConnectedAgent>
  pendingResults: Map<string, PendingResult>
  pendingTasks: Map<string, PendingTask>
  connectHandlers: ((agent: ConnectedAgent) => void)[]
  disconnectHandlers: ((agentId: string) => void)[]
}

function send(ws: WS, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg))
}

function handleMessage(s: GatewayState, ws: WS, raw: string | Buffer): void {
  let msg: AgentMessage
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as AgentMessage
  } catch {
    send(ws, { type: 'error', message: 'Invalid JSON' })
    return
  }

  switch (msg.type) {
    case 'register': {
      const existing = s.agents.get(msg.agentId)
      if (existing?.ws) {
        send(ws, { type: 'error', message: `Agent "${msg.agentId}" already connected` })
        return
      }

      const agent: ConnectedAgent = {
        agentId: msg.agentId,
        name: msg.name,
        capabilities: msg.capabilities,
        channel: 'websocket',
        connectedAt: new Date(),
        ws,
      }

      s.agents.set(msg.agentId, agent)
      send(ws, { type: 'welcome', agentId: msg.agentId })
      console.log(`[gateway] agent connected: ${msg.agentId} (${msg.name})`)

      for (const handler of s.connectHandlers) handler(agent)

      for (const [taskId, entry] of s.pendingTasks) {
        if (entry.agentId === msg.agentId) {
          send(ws, { type: 'assignment', task: entry.task })
          s.pendingTasks.delete(taskId)
        }
      }
      break
    }

    case 'result': {
      const pending = s.pendingResults.get(msg.taskId)
      if (!pending) {
        send(ws, { type: 'error', message: `No pending task: ${msg.taskId}` })
        return
      }

      clearTimeout(pending.timer)
      s.pendingResults.delete(msg.taskId)

      const agentId = [...s.agents.entries()].find(([_, a]) => a.ws === ws)?.[0] ?? 'unknown'
      console.log(`[gateway] result received: task=${msg.taskId} agent=${agentId}`)

      pending.resolve({
        taskId: msg.taskId,
        agentId,
        content: msg.content,
        receivedAt: new Date(),
      })
      break
    }

    case 'heartbeat':
      break
  }
}

function handleClose(s: GatewayState, ws: WS): void {
  for (const [id, agent] of s.agents) {
    if (agent.ws === ws) {
      s.agents.delete(id)
      console.log(`[gateway] agent disconnected: ${id}`)
      for (const handler of s.disconnectHandlers) handler(id)
      break
    }
  }
}

// Module-level state — Bun.serve closures need this to be reachable
let _state: GatewayState | null = null

export function createGateway(config: GatewayConfig): Gateway {
  const s: GatewayState = {
    agents: new Map(),
    pendingResults: new Map(),
    pendingTasks: new Map(),
    connectHandlers: [],
    disconnectHandlers: [],
  }

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null
  let server: { stop(): void } | null = null

  return {
    start() {
      _state = s
      server = Bun.serve({
        port: config.port,
        fetch(req, srv) {
          const st = _state!
          const url = new URL(req.url)

          if (url.pathname === '/ws') {
            const upgraded = srv.upgrade(req, {})
            if (!upgraded) {
              return new Response('WebSocket upgrade failed', { status: 400 })
            }
            return undefined
          }

          if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/tasks')) {
            const agentId = url.pathname.split('/')[3]!
            const tasks: TaskAssignment[] = []
            for (const [_, entry] of st.pendingTasks) {
              if (entry.agentId === agentId) tasks.push(entry.task)
            }
            return Response.json({ tasks })
          }

          if (req.method === 'POST' && url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/result')) {
            const taskId = url.pathname.split('/')[3]!
            return (async () => {
              const body = await req.json() as { content: string; agentId: string }
              const pending = st.pendingResults.get(taskId)
              if (!pending) {
                return Response.json({ error: 'No pending task' }, { status: 404 })
              }

              clearTimeout(pending.timer)
              st.pendingResults.delete(taskId)

              pending.resolve({
                taskId,
                agentId: body.agentId,
                content: body.content,
                receivedAt: new Date(),
              })

              return Response.json({ ok: true })
            })()
          }

          if (url.pathname === '/api/status') {
            return Response.json({
              agents: [...st.agents.values()].map(a => ({
                agentId: a.agentId,
                name: a.name,
                channel: a.channel,
                connectedAt: a.connectedAt.toISOString(),
              })),
              pendingTasks: st.pendingTasks.size,
              pendingResults: st.pendingResults.size,
            })
          }

          return new Response('Not found', { status: 404 })
        },
        websocket: {
          message(ws, raw) { handleMessage(s, ws as unknown as WS, raw) },
          close(ws) { handleClose(s, ws as unknown as WS) },
          open() {},
        },
      })

      heartbeatInterval = setInterval(() => {
        for (const agent of s.agents.values()) {
          if (agent.ws) {
            send(agent.ws as WS, { type: 'heartbeat' })
          }
        }
      }, config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS)

      console.log(`[gateway] listening on ws://localhost:${config.port}/ws`)
      console.log(`[gateway] REST fallback on http://localhost:${config.port}/api/`)
    },

    stop() {
      if (heartbeatInterval) clearInterval(heartbeatInterval)
      for (const pending of s.pendingResults.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Gateway shutting down'))
      }
      s.pendingResults.clear()
      server?.stop()
      console.log('[gateway] stopped')
    },

    assign(agentId, task) {
      const agent = s.agents.get(agentId)
      if (agent?.ws) {
        send(agent.ws as WS, { type: 'assignment', task })
        console.log(`[gateway] assigned task=${task.id} to ${agentId} via websocket`)
      } else {
        s.pendingTasks.set(task.id, { agentId, task })
        console.log(`[gateway] queued task=${task.id} for ${agentId} (not connected)`)
      }
    },

    waitForResult(taskId, timeoutMs) {
      const timeout = timeoutMs ?? config.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
      return new Promise<TaskResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          s.pendingResults.delete(taskId)
          reject(new Error(`Task ${taskId} timed out after ${timeout}ms`))
        }, timeout)

        s.pendingResults.set(taskId, { resolve, reject, timer })
      })
    },

    getConnectedAgents() {
      return [...s.agents.values()]
    },

    isAgentConnected(agentId) {
      return s.agents.has(agentId)
    },

    onAgentConnect(handler) {
      s.connectHandlers.push(handler)
    },

    onAgentDisconnect(handler) {
      s.disconnectHandlers.push(handler)
    },
  }
}
