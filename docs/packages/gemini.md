# @floor-agents/gemini

LLM adapter for [Google Gemini API](https://ai.google.dev/). Supports tool use (function calling) for structured output.

Created by the Floor Agents AI team (Claude Code Sonnet, reviewed by Opus CTO) in sprint 2.

## Structure

```
packages/gemini/src/
├── index.ts       ← re-exports
└── adapter.ts     ← createGeminiAdapter
```

## Usage

```typescript
import { createGeminiAdapter } from '@floor-agents/gemini'

const adapter = createGeminiAdapter({
  apiKey: 'AIza...',
})

const response = await adapter.run({
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  system: 'You are a coding agent.',
  messages: [{ role: 'user', content: 'Write a hello world function.' }],
  tools: [{ name: 'write_file', description: '...', inputSchema: { ... } }],
  maxTokens: 8192,
  temperature: 0,
})
```

## Features

- **Tool use**: maps `ToolDefinition` to Gemini's `functionDeclarations` format
- **Multi-turn support**: converts Anthropic-style `ContentBlock[]` to Gemini message format (model/user roles, functionCall/functionResponse parts)
- **Cost estimation**: hardcoded pricing per model
- **Retry**: 3 retries with exponential backoff on 5xx errors
- **429 handling**: respects `Retry-After` header
- **120s timeout**

## Pricing

| Model | Input $/M | Output $/M |
|-------|-----------|------------|
| gemini-2.5-pro | $1.25 | $10.00 |
| gemini-2.5-flash | $0.15 | $0.60 |
| Unknown models | $0.15 | $0.60 |

## Config in YAML

```yaml
agents:
  - id: backend
    llm:
      provider: gemini
      model: gemini-2.5-flash
```

Requires `GEMINI_API_KEY` env var.

## API Format

Gemini uses a different API format than OpenAI/Anthropic:

- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- Auth via URL parameter: `?key={apiKey}`
- System prompt: `systemInstruction.parts[].text`
- Messages: `contents[].role` (`user` / `model`) with `parts[]`
- Tool calls: `parts[].functionCall.name` + `parts[].functionCall.args`
- Tool results: `parts[].functionResponse.name` + `parts[].functionResponse.response`
