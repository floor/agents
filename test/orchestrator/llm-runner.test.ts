import { test, expect, describe } from 'bun:test'
import type {
  LLMAdapter,
  LLMConfig,
  LLMResponse,
  AgentDefinition,
  ToolDefinition,
} from '@floor-agents/core'
import { runToolUseLoop } from '@floor-agents/orchestrator'

// ── Mock helpers ────────────────────────────────────────────────────

function makeAgent(id: string = 'claude', provider: string = 'anthropic'): AgentDefinition {
  return {
    id,
    name: `Agent ${id}`,
    promptTemplate: 'agents/committee.md',
    llm: { provider, model: 'test', temperature: 0.3, maxTokens: 4096 },
    capabilities: ['read_code'],
    autonomy: 'T1',
    customInstructions: '',
    external: false,
  }
}

// An adapter that NEVER terminates: every response asks for another tool call.
function neverEndingLLM(): LLMAdapter & { callCount: number } {
  const adapter = {
    callCount: 0,
    async run(_config: LLMConfig): Promise<LLMResponse> {
      adapter.callCount++
      return {
        content: 'thinking...',
        toolCalls: [{ id: `call-${adapter.callCount}`, name: 'noop', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 50, cost: 0.001 },
        provider: 'anthropic',
        model: 'test',
        durationMs: 10,
      }
    },
  }
  return adapter
}

const tools: readonly ToolDefinition[] = [
  { name: 'noop', description: 'does nothing', inputSchema: {} },
]

// ── Tests ───────────────────────────────────────────────────────────

describe('runToolUseLoop tool-round cap', () => {
  test('terminates at the cap instead of looping forever', async () => {
    const llm = neverEndingLLM()

    // If the cap were missing, this promise would never resolve and the test
    // would hang until bun's per-test timeout kills it.
    const result = await runToolUseLoop(
      makeAgent(),
      'system',
      [{ role: 'user', content: 'go' }],
      tools,
      () => llm,
      async () => 'ok',
    )

    // The loop is capped at MAX_TOOL_ROUNDS (25) — the LLM is invoked exactly
    // that many times before the loop bails out.
    expect(llm.callCount).toBe(25)

    // The accumulated result is still returned so the caller can record cost.
    expect(result.totalCost).toBeCloseTo(0.025, 6)
    expect(result.toolCalls.length).toBe(25)
  })
})
