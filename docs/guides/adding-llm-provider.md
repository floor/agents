# Adding an LLM Provider

This guide walks through adding a new LLM provider adapter to Floor Agents.

## Overview

Each LLM provider is a separate package under `packages/`. The adapter implements the `LLMAdapter` type from `@floor-agents/core` and translates between our internal message format and the provider's API.

## Steps

### 1. Create the package

```bash
mkdir -p packages/my-provider/src
```

**`packages/my-provider/package.json`:**
```json
{
  "name": "@floor-agents/my-provider",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "module": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@floor-agents/core": "workspace:*"
  }
}
```

**`packages/my-provider/tsconfig.json`:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "paths": { "@floor-agents/*": ["../../packages/*/src"] }
  },
  "include": ["src"]
}
```

### 2. Implement the adapter

**`packages/my-provider/src/adapter.ts`:**

```typescript
import type { LLMAdapter, LLMConfig, LLMResponse, ToolCall, ContentBlock } from '@floor-agents/core'

export type MyProviderConfig = {
  readonly apiKey: string
  readonly baseUrl?: string
}

export function createMyProviderAdapter(config: MyProviderConfig): LLMAdapter {
  return {
    async run(llmConfig: LLMConfig): Promise<LLMResponse> {
      const start = performance.now()

      // 1. Convert llmConfig.messages to your provider's format
      //    Handle both string content and ContentBlock[] arrays
      //    (ContentBlock[] appears in multi-turn tool use conversations)

      // 2. Convert llmConfig.tools to your provider's tool format

      // 3. Call the API

      // 4. Parse the response:
      //    - Extract text content → response.content
      //    - Extract tool calls → response.toolCalls (as ToolCall[])
      //    - Map finish reason → response.stopReason

      return {
        content: '...',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        },
        provider: 'my-provider',
        model: llmConfig.model,
        durationMs: Math.round(performance.now() - start),
      }
    },
  }
}
```

### 3. Handle multi-turn messages

When the orchestrator runs a multi-turn tool use conversation, it sends messages with `ContentBlock[]` content (Anthropic format). Your adapter must convert these:

- **Assistant messages with `tool_use` blocks**: convert to your provider's tool call format
- **User messages with `tool_result` blocks**: convert to your provider's tool result format

See `packages/lmstudio/src/adapter.ts` for a complete example of converting to OpenAI format.

### 4. Create the barrel export

**`packages/my-provider/src/index.ts`:**
```typescript
export { createMyProviderAdapter } from './adapter.ts'
export type { MyProviderConfig } from './adapter.ts'
```

### 5. Register in main.ts

Add the provider to `src/main.ts`:

```typescript
import { createMyProviderAdapter } from '@floor-agents/my-provider'

if (requiredProviders.has('my-provider')) {
  const adapter = createMyProviderAdapter({
    apiKey: requireEnv('MY_PROVIDER_API_KEY'),
  })
  llmAdapters.set('my-provider', adapter)
}
```

### 6. Add tests

**`test/my-provider/adapter.test.ts`:**
```typescript
import { test, expect } from 'bun:test'
import { createMyProviderAdapter } from '@floor-agents/my-provider'

test('creates adapter', () => {
  const adapter = createMyProviderAdapter({ apiKey: 'test' })
  expect(typeof adapter.run).toBe('function')
})
```

### 7. Install and verify

```bash
bun install
bun run typecheck
bun test
```

## Key Implementation Notes

- **No SDK dependencies**: use native `fetch` for API calls
- **Retry logic**: implement exponential backoff for transient errors
- **Timeout**: use `AbortController` with a reasonable timeout (120s for cloud, 300s for local)
- **Cost estimation**: return estimated USD cost based on token counts. Return 0 for local/free providers.
- **stopReason mapping**: map your provider's finish reason to `'end_turn' | 'tool_use' | 'max_tokens'`
