# Agent Gateway

The gateway enables external agents (like OpenAI Codex) to participate in Floor Agents workflows. It exposes a WebSocket server for real-time communication and a REST API as fallback for agents that can't hold persistent connections.

## Architecture

```
┌─────────────┐     WebSocket      ┌─────────────┐
│   Codex     │ ◄────────────────► │   Gateway   │
│  (external) │   register/assign  │  :3100/ws   │
└─────────────┘    /result/hb      └──────┬──────┘
                                          │
┌─────────────┐     REST fallback  ┌──────┴──────┐
│   Custom    │ ◄────────────────► │  :3100/api  │
│   Agent     │   poll / submit    └──────┬──────┘
└─────────────┘                           │
                                   ┌──────┴──────┐
                                   │ Orchestrator│
                                   │  (internal) │
                                   └─────────────┘
```

Internal agents (Claude Code, Gemma via LM Studio) are dispatched directly by the orchestrator through their LLM adapters. External agents connect to the gateway themselves and receive assignments in real time.

## Quick Start

### 1. Enable in config

Mark agents as `external: true` in your company YAML:

```yaml
agents:
  - id: codex
    name: "Codex (OpenAI)"
    llm:
      provider: openai
      model: codex-mini-latest
    capabilities: [vote]
    external: true
```

### 2. Set environment variables

```bash
GATEWAY_PORT=3100        # default
GATEWAY_TOKEN=your-secret-token
```

The gateway starts automatically when external agents are present in the config.

### 3. Run the Codex agent

```bash
GATEWAY_URL=ws://localhost:3100 \
GATEWAY_TOKEN=your-secret-token \
OPENAI_API_KEY=sk-... \
bun scripts/codex-agent.ts
```

## WebSocket Protocol

Connect to `ws://host:port/ws?token=<token>`.

All messages are JSON. The protocol has four phases:

### 1. Registration

Agent sends:
```json
{
  "type": "register",
  "agentId": "codex",
  "name": "Codex (OpenAI)",
  "capabilities": ["vote"]
}
```

Server responds:
```json
{
  "type": "welcome",
  "agentId": "codex"
}
```

### 2. Assignment

When work is available, the server pushes:
```json
{
  "type": "assignment",
  "task": {
    "id": "issue-123:codex",
    "issueId": "issue-123",
    "title": "RFC-042: Migrate to PostgreSQL",
    "body": "Full proposal text...",
    "systemPrompt": "You are a technical committee member...",
    "createdAt": "2026-05-19T10:30:00.000Z"
  }
}
```

### 3. Result

Agent sends back its review:
```json
{
  "type": "result",
  "taskId": "issue-123:codex",
  "content": "Analysis here...\n\nVOTE: APPROVE"
}
```

### 4. Heartbeat

Server sends periodic heartbeats. Agents should echo them back:

```json
{ "type": "heartbeat" }
```

## REST Fallback

For agents that can't maintain WebSocket connections.

### Poll for tasks

```
GET /api/agents/:agentId/tasks
Authorization: Bearer <token>
```

Returns:
```json
{
  "tasks": [
    { "id": "...", "issueId": "...", "title": "...", "body": "...", "systemPrompt": "...", "createdAt": "..." }
  ]
}
```

### Submit result

```
POST /api/tasks/:taskId/result
Authorization: Bearer <token>
Content-Type: application/json

{
  "agentId": "codex",
  "content": "My review...\n\nVOTE: REJECT"
}
```

### Server status

```
GET /api/status
Authorization: Bearer <token>
```

Returns connected agents, pending task/result counts.

## Authentication

Set `GATEWAY_TOKEN` to enable authentication. When set:

- **WebSocket:** Pass `?token=<token>` as a query parameter on the connection URL
- **REST:** Pass `Authorization: Bearer <token>` header

When `GATEWAY_TOKEN` is unset, the gateway accepts all connections (development mode).

## Reconnection

The gateway tracks in-flight tasks per agent. If an agent disconnects while a task is assigned:

1. The task is moved back to the pending queue
2. When the agent reconnects and re-registers, pending tasks are re-dispatched immediately

The `createGatewayClient()` helper handles reconnection automatically with exponential backoff (default: 10 attempts, starting at 3s).

## Building a Custom Agent

Use the gateway client library:

```typescript
import { createGatewayClient } from '@floor-agents/gateway'

const client = createGatewayClient({
  url: 'ws://localhost:3100',
  agentId: 'my-agent',
  name: 'My Custom Agent',
  capabilities: ['vote'],
  token: process.env.GATEWAY_TOKEN,
})

client.onTask(async (task) => {
  // Process the task, return the result content
  const analysis = await yourReviewFunction(task.title, task.body)
  return `${analysis}\n\nVOTE: APPROVE`
})

client.connect()
```

Or implement the protocol directly — it's just JSON over WebSocket.

## Message Validation

All incoming messages are validated before processing. Invalid messages receive an error response:

```json
{ "type": "error", "message": "Invalid message shape" }
```

A `register` message must have non-empty `agentId`, `name`, and a `capabilities` array of strings. A `result` message must have a non-empty `taskId` and a `content` string.

## Server Messages Reference

| Type | Direction | Description |
|------|-----------|-------------|
| `welcome` | Server → Agent | Registration confirmed |
| `assignment` | Server → Agent | New task dispatched |
| `assignment_cancelled` | Server → Agent | Task cancelled (with reason) |
| `heartbeat` | Bidirectional | Keep-alive |
| `error` | Server → Agent | Error message |

## Agent Messages Reference

| Type | Direction | Description |
|------|-----------|-------------|
| `register` | Agent → Server | Register with ID, name, capabilities |
| `result` | Agent → Server | Task result with content |
| `heartbeat` | Agent → Server | Keep-alive response |
