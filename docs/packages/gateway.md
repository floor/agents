# @floor-agents/gateway

WebSocket server and client for external agent communication. Enables agents outside the orchestrator's process (like OpenAI Codex) to receive task assignments and submit results in real time.

## Structure

```
packages/gateway/src/
├── index.ts       ← re-exports
├── gateway.ts     ← createGateway server (Bun.serve WebSocket + REST)
├── client.ts      ← createGatewayClient (auto-reconnect WebSocket client)
└── types.ts       ← protocol types + message validation
```

## Server

```typescript
import { createGateway } from '@floor-agents/gateway'

const gateway = createGateway({
  port: 3100,
  token: 'shared-secret',       // optional — omit for dev mode
  heartbeatIntervalMs: 30_000,  // default
  taskTimeoutMs: 300_000,       // default: 5 min
})

gateway.start()

// Assign a task to an agent (queued if not connected)
gateway.assign('codex', {
  id: 'task-1',
  issueId: 'issue-1',
  title: 'RFC-042',
  body: 'Proposal text...',
  systemPrompt: 'Review this.',
  createdAt: new Date().toISOString(),
})

// Wait for the result
const result = await gateway.waitForResult('task-1', 60_000)
console.log(result.content) // "Analysis... VOTE: APPROVE"
```

### Authentication

When `token` is set:
- **WebSocket:** `ws://host:port/ws?token=<token>`
- **REST:** `Authorization: Bearer <token>`

When `token` is omitted, all connections are accepted.

### Task lifecycle

1. `assign()` — if agent is connected, pushes via WebSocket and tracks as in-flight. If not, queues for later.
2. Agent connects — any queued tasks for that agent are dispatched immediately.
3. Agent disconnects — any in-flight tasks are re-queued for retry on reconnect.
4. `waitForResult()` — returns a Promise that resolves when the agent sends back a result, or rejects on timeout.

### REST fallback

For agents that can't hold WebSocket connections:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agents/:id/tasks` | GET | Poll for pending tasks |
| `/api/tasks/:id/result` | POST | Submit a task result |
| `/api/status` | GET | Server status (agents, pending counts) |

## Client

```typescript
import { createGatewayClient } from '@floor-agents/gateway'

const client = createGatewayClient({
  url: 'ws://localhost:3100',
  agentId: 'my-agent',
  name: 'My Agent',
  capabilities: ['vote'],
  token: 'shared-secret',
  reconnectDelayMs: 3_000,        // default
  maxReconnectAttempts: 10,       // default
})

client.onTask(async (task) => {
  // Process task, return result content
  return `My analysis...\n\nVOTE: APPROVE`
})

client.connect()
```

The client handles:
- Auto-registration on connect
- Exponential backoff on disconnect (3s, 6s, 12s, ... capped at 96s)
- Heartbeat echo
- Error responses sent back if the task handler throws

## Message validation

All incoming messages are validated with `validateAgentMessage()` before processing. Invalid messages receive `{ type: "error", message: "Invalid message shape" }`.

Exported for reuse:

```typescript
import { validateAgentMessage } from '@floor-agents/gateway'

validateAgentMessage({ type: 'register', agentId: 'a', name: 'A', capabilities: [] })
// true
```

## Config

| Env Variable | Required | Default | Description |
|-------------|:--------:|---------|-------------|
| `GATEWAY_PORT` | No | `3100` | Server port |
| `GATEWAY_TOKEN` | No | — | Shared secret for auth |

The gateway starts automatically in `src/main.ts` when any agent in the config has `external: true`.

## Protocol reference

See [Gateway documentation](../gateway.md) for the full WebSocket protocol spec, message formats, and guide to building custom agents.
