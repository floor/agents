import type { ServerMessage, TaskAssignment } from './types.ts'

export type GatewayClientConfig = {
  readonly url: string
  readonly agentId: string
  readonly name: string
  readonly capabilities: readonly string[]
  readonly token?: string
  readonly reconnectDelayMs?: number
  readonly maxReconnectAttempts?: number
}

export type TaskHandler = (task: TaskAssignment) => Promise<string>

export type GatewayClient = {
  connect(): void
  disconnect(): void
  onTask(handler: TaskHandler): void
}

const DEFAULT_RECONNECT_DELAY_MS = 3_000
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10

export function createGatewayClient(config: GatewayClientConfig): GatewayClient {
  let ws: WebSocket | null = null
  let taskHandler: TaskHandler | null = null
  let reconnectAttempts = 0
  let shouldReconnect = true
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const reconnectDelay = config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
  const maxAttempts = config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS

  function buildUrl(): string {
    const base = config.url.endsWith('/ws') ? config.url : `${config.url}/ws`
    return config.token ? `${base}?token=${encodeURIComponent(config.token)}` : base
  }

  function scheduleReconnect(): void {
    if (!shouldReconnect) return
    if (reconnectAttempts >= maxAttempts) {
      console.error(`[client:${config.agentId}] max reconnect attempts (${maxAttempts}) reached`)
      return
    }

    const delay = reconnectDelay * Math.min(2 ** reconnectAttempts, 32)
    reconnectAttempts++
    console.log(`[client:${config.agentId}] reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxAttempts})`)
    reconnectTimer = setTimeout(() => connect(), delay)
  }

  function connect(): void {
    const url = buildUrl()
    console.log(`[client:${config.agentId}] connecting to ${config.url}`)

    ws = new WebSocket(url)

    ws.onopen = () => {
      reconnectAttempts = 0
      ws!.send(JSON.stringify({
        type: 'register',
        agentId: config.agentId,
        name: config.name,
        capabilities: config.capabilities,
      }))
    }

    ws.onmessage = async (event) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(event.data as string) as ServerMessage
      } catch {
        console.error(`[client:${config.agentId}] invalid message from server`)
        return
      }

      switch (msg.type) {
        case 'welcome':
          console.log(`[client:${config.agentId}] registered`)
          break

        case 'assignment': {
          if (!taskHandler) {
            console.error(`[client:${config.agentId}] received task but no handler registered`)
            break
          }

          const { task } = msg
          console.log(`[client:${config.agentId}] received task=${task.id}: ${task.title}`)

          try {
            const content = await taskHandler(task)
            ws!.send(JSON.stringify({
              type: 'result',
              taskId: task.id,
              content,
            }))
            console.log(`[client:${config.agentId}] submitted result for task=${task.id}`)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.error(`[client:${config.agentId}] task handler error: ${message}`)
            ws!.send(JSON.stringify({
              type: 'result',
              taskId: task.id,
              content: `Error processing task: ${message}\n\nVOTE: ABSTAIN`,
            }))
          }
          break
        }

        case 'heartbeat':
          ws!.send(JSON.stringify({ type: 'heartbeat' }))
          break

        case 'error':
          console.error(`[client:${config.agentId}] server error: ${msg.message}`)
          break
      }
    }

    ws.onclose = () => {
      console.log(`[client:${config.agentId}] disconnected`)
      ws = null
      scheduleReconnect()
    }

    ws.onerror = (event) => {
      console.error(`[client:${config.agentId}] connection error`)
    }
  }

  return {
    connect() {
      shouldReconnect = true
      reconnectAttempts = 0
      connect()
    },

    disconnect() {
      shouldReconnect = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
      ws = null
    },

    onTask(handler) {
      taskHandler = handler
    },
  }
}
