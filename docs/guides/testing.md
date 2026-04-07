# Testing

## Overview

Floor Agents uses [bun:test](https://bun.sh/docs/cli/test) for all tests. Tests live in the root `test/` directory, organized by package.

```
test/
├── core/
│   ├── tokens.test.ts
│   ├── config-loader.test.ts
│   └── config-validator.test.ts
├── anthropic/
│   └── pricing.test.ts
├── openai/
│   ├── adapter.test.ts
│   └── pricing.test.ts
├── lmstudio/
│   └── adapter.test.ts
├── task/
│   └── factory.test.ts
└── orchestrator/
    ├── output-parser.test.ts
    ├── guardrails.test.ts
    ├── cost-tracker.test.ts
    ├── dispatcher.test.ts
    ├── state-store.test.ts
    └── integration.test.ts
```

## Running Tests

```bash
# All tests
bun test

# Specific file
bun test test/orchestrator/guardrails.test.ts

# Pattern match
bun test --filter "guardrails"
```

## Test Categories

### Unit Tests

Test individual modules in isolation. Most tests fall here.

- **Config loader**: valid/invalid YAML, missing files, default fallback
- **Config validator**: each validation rule individually
- **Output parser**: tool call extraction, missing tools, fallback PR description
- **Guardrails**: each violation type (file count, size, blocked paths, path traversal)
- **Cost tracker**: per-task limits, daily limits, day rollover
- **Dispatcher**: label matching, capability fallback
- **State store**: save/load/list, atomic writes, corrupt file handling
- **Pricing**: known models, unknown model fallback, local = $0

### Integration Tests

Test the full pipeline with mocked adapters (`test/orchestrator/integration.test.ts`):

1. **Happy path**: issue → LLM → branch → PR → status update
2. **Guardrail violation**: blocked path prevents PR creation
3. **Parse failure + retry**: LLM returns no tool calls, retries once
4. **Cost limit**: daily budget exhausted, task skipped
5. **Crash recovery**: resumes from saved execution state

## Writing Tests

### Conventions

```typescript
import { test, expect } from 'bun:test'

test('descriptive name of what is tested', () => {
  // arrange
  const input = ...

  // act
  const result = doSomething(input)

  // assert
  expect(result).toBe(expected)
})
```

- Use `bun:test` (not jest, vitest, etc.)
- One behavior per test
- Descriptive test names
- Use `beforeEach`/`afterEach` for setup/teardown (e.g. temp directories)

### Mocking Adapters

For integration tests, create mock adapters that implement the interface:

```typescript
function mockLLMAdapter(toolCalls = []): LLMAdapter {
  return {
    async run(): Promise<LLMResponse> {
      return {
        content: 'reasoning...',
        toolCalls,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        provider: 'test',
        model: 'test',
        durationMs: 0,
      }
    },
  }
}
```

See `test/orchestrator/integration.test.ts` for complete mock implementations of all adapters.

### Testing with Temp Directories

The state store tests use temporary directories:

```typescript
import { mkdir, rm } from 'node:fs/promises'

const TEST_DIR = './data/test-executions'

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})
```

## Type Checking

```bash
bun run typecheck
```

Runs `tsc --noEmit` across all packages. The root `tsconfig.json` includes all package sources and tests.
