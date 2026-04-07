# @floor-agents/openai

LLM adapter for OpenAI and any OpenAI-compatible API endpoint (Ollama, Together AI, Groq, Fireworks, etc.).

## Structure

```
packages/openai/src/
├── index.ts       ← re-exports
├── adapter.ts     ← createOpenAIAdapter
└── pricing.ts     ← estimateCost per model
```

## Usage

```typescript
import { createOpenAIAdapter } from '@floor-agents/openai'

// OpenAI
const openai = createOpenAIAdapter({
  apiKey: 'sk-...',
})

// Ollama
const ollama = createOpenAIAdapter({
  baseUrl: 'http://localhost:11434/v1',
})

// Together AI
const together = createOpenAIAdapter({
  apiKey: 'tog-...',
  baseUrl: 'https://api.together.xyz/v1',
})
```

## Features

- **Tool use**: OpenAI function calling format
- **Multi-turn support**: converts Anthropic-style `ContentBlock[]` to OpenAI `tool_calls` + `role: "tool"` format
- **Local detection**: automatically sets cost to $0 for localhost URLs
- **Retry with backoff**: 3 retries at 1s/2s/4s on 5xx errors
- **429 handling**: respects `Retry-After` header
- **120s timeout**

## Pricing (OpenAI models)

| Model | Input $/M | Output $/M |
|-------|-----------|------------|
| gpt-4o | $2.50 | $10.00 |
| gpt-4o-mini | $0.15 | $0.60 |
| o3 | $10.00 | $40.00 |
| o3-mini | $1.10 | $4.40 |
| Local models | $0 | $0 |

## Config in YAML

```yaml
agents:
  - id: backend
    llm:
      provider: openai      # or: ollama, local
      model: gpt-4o
```

Env vars:
- `OPENAI_API_KEY` — required for OpenAI, optional for local endpoints
- `OPENAI_BASE_URL` — defaults to `https://api.openai.com/v1`
