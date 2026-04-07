# @floor-agents/anthropic

LLM adapter for [Anthropic's Claude API](https://docs.anthropic.com/en/docs/about-claude/models). Supports tool use for structured output.

## Structure

```
packages/anthropic/src/
├── index.ts       ← re-exports
├── adapter.ts     ← createAnthropicAdapter
└── pricing.ts     ← estimateCost per model
```

## Usage

```typescript
import { createAnthropicAdapter } from '@floor-agents/anthropic'

const adapter = createAnthropicAdapter({
  apiKey: 'sk-ant-...',
  baseUrl: 'https://api.anthropic.com', // optional
})

const response = await adapter.run({
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  system: 'You are a coding agent.',
  messages: [{ role: 'user', content: 'Write a hello world function.' }],
  tools: [{ name: 'write_file', description: '...', inputSchema: { ... } }],
  maxTokens: 4096,
  temperature: 0,
})

// response.toolCalls — structured tool calls
// response.content — text reasoning
// response.stopReason — 'end_turn' | 'tool_use' | 'max_tokens'
// response.usage — { inputTokens, outputTokens, cost }
```

## Features

- **Tool use**: sends `tools` parameter, parses `tool_use` content blocks from response
- **Retry with backoff**: 3 retries at 1s/2s/4s delays on 5xx errors
- **429 rate limiting**: respects `Retry-After` header
- **529 overloaded**: waits 10s, retries once
- **Timeout**: 120s per request via `AbortController`
- **Cost estimation**: hardcoded pricing table per model

## Pricing

| Model | Input $/M | Output $/M |
|-------|-----------|------------|
| claude-sonnet-4-20250514 | $3.00 | $15.00 |
| claude-opus-4-0-20250115 | $15.00 | $75.00 |
| claude-haiku-4-5-20251001 | $0.80 | $4.00 |
| Unknown models | $3.00 | $15.00 |

## Config in YAML

```yaml
agents:
  - id: cto
    llm:
      provider: anthropic
      model: claude-sonnet-4-20250514
```

Requires `ANTHROPIC_API_KEY` env var.
