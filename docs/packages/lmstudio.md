# @floor-agents/lmstudio

LLM adapter for [LM Studio](https://lmstudio.ai) — run local models (Gemma, Llama, Qwen, Mistral, etc.) as coding agents with zero API costs.

## Structure

```
packages/lmstudio/src/
├── index.ts       ← re-exports
└── adapter.ts     ← createLMStudioAdapter
```

## Usage

```typescript
import { createLMStudioAdapter } from '@floor-agents/lmstudio'

const adapter = createLMStudioAdapter({
  baseUrl: 'http://localhost:1234/v1', // optional, this is the default
})

const response = await adapter.run({
  provider: 'lmstudio',
  model: 'google/gemma-4-e2b',
  system: 'You are a coding agent.',
  messages: [{ role: 'user', content: 'Write a retry utility.' }],
  tools: [{ name: 'write_file', description: '...', inputSchema: { ... } }],
  maxTokens: 4096,
  temperature: 0,
})
```

## Features

- **Tool use**: maps to OpenAI-compatible function calling format
- **Multi-turn support**: correctly converts Anthropic-style `ContentBlock[]` messages to OpenAI `tool_calls` + `role: "tool"` format for multi-turn conversations
- **Cost is always $0**: local inference has no per-token cost
- **5-minute timeout**: local models can be slower than cloud APIs
- **Retry**: 2 retries at 2s/5s on server errors
- **No API key required**: LM Studio doesn't need authentication by default

## Tested Models

| Model | Tool Use | Quality | Speed |
|-------|:--------:|---------|-------|
| google/gemma-4-e2b | Yes | Good for simple tasks | Fast |
| google/gemma-4-e4b | Yes | Better quality | Medium |
| google/gemma-4-27b | Yes | Strong | Slower |
| qwen/qwen3-coder-next | Yes | Good for code | Medium |

## Config in YAML

```yaml
agents:
  - id: backend
    llm:
      provider: lmstudio
      model: google/gemma-4-e2b
      temperature: 0.2
      maxTokens: 8000
```

Optional env vars:
- `LMSTUDIO_BASE_URL` — defaults to `http://localhost:1234/v1`
- `LMSTUDIO_API_KEY` — only if your LM Studio instance requires auth

## Setup

1. Install [LM Studio](https://lmstudio.ai)
2. Download a model (e.g. Gemma 4 E2B)
3. Start the local server
4. Verify: `curl http://localhost:1234/v1/models`
