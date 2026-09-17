import { test, expect, describe } from 'bun:test'
import type { AgentDefinition, LLMAdapter, LLMResponse, ToolCall } from '@floor-agents/core'
import {
  createOrchestratorAgent,
  applyGuards,
  initialGuardState,
  type OrchestratorTool,
} from '@floor-agents/orchestrator'

// ── Pure guardrail policy (no LLM, no IO) ───────────────────────────

describe('applyGuards — the two net-new guardrails', () => {
  test('ground-before-act: act is refused before any inspect', () => {
    const d = applyGuards(initialGuardState(), 'act')
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('ground-before-act')
  })

  test('inspect then act is allowed', () => {
    const afterInspect = applyGuards(initialGuardState(), 'inspect').next
    expect(applyGuards(afterInspect, 'act').allowed).toBe(true)
  })

  test('objective-verification: done is refused with no passing verify', () => {
    const d = applyGuards({ inspected: true, lastVerifyPassed: false }, 'done')
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('objective-verification')
  })

  test('verify(pass) enables done; verify(fail) does not', () => {
    expect(applyGuards(initialGuardState(), 'verify', true).next.lastVerifyPassed).toBe(true)
    expect(applyGuards(initialGuardState(), 'verify', false).next.lastVerifyPassed).toBe(false)
    const passed = applyGuards(initialGuardState(), 'verify', true).next
    expect(applyGuards(passed, 'done').allowed).toBe(true)
  })

  test('an act invalidates a prior passing verify (must re-verify before done)', () => {
    const passed = applyGuards({ inspected: true, lastVerifyPassed: true }, 'verify', true).next
    const afterEdit = applyGuards(passed, 'act').next
    expect(afterEdit.lastVerifyPassed).toBe(false)
    expect(applyGuards(afterEdit, 'done').allowed).toBe(false)
  })
})

// ── Full loop with a scripted mock LLM ──────────────────────────────

const AGENT: AgentDefinition = {
  id: 'orchestrator',
  name: 'Orchestrator',
  promptTemplate: '',
  llm: { provider: 'mock', model: 'mock', temperature: 0, maxTokens: 1000 },
  capabilities: ['decompose_task'],
  autonomy: 'T1',
  customInstructions: '',
}

/** A mock LLM that emits one scripted tool call per round, then ends. */
function scriptedAdapter(rounds: ToolCall[][]): LLMAdapter {
  let i = 0
  return {
    async run(): Promise<LLMResponse> {
      const calls = rounds[i] ?? []
      const useTools = i < rounds.length && calls.length > 0
      i++
      return {
        content: '',
        toolCalls: calls,
        stopReason: useTools ? 'tool_use' : 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
        provider: 'mock',
        model: 'mock',
        durationMs: 1,
      }
    },
  }
}

const tc = (name: string): ToolCall => ({ id: `tc-${name}-${Math.random()}`, name, input: {} })

/** Mock tools that record what actually executed; verify result is configurable. */
function makeTools(verifyPasses: boolean): { tools: OrchestratorTool[]; ran: string[] } {
  const ran: string[] = []
  const t = (name: string, kind: OrchestratorTool['kind'], extra?: () => { verifyPassed?: boolean }): OrchestratorTool => ({
    def: { name, description: name, inputSchema: { type: 'object', properties: {} } },
    kind,
    run: async () => {
      ran.push(name)
      return { output: `${name} ran`, ...(extra ? extra() : {}) }
    },
  })
  return {
    ran,
    tools: [
      t('inspect_repo', 'inspect'),
      t('edit_code', 'act'),
      t('verify', 'verify', () => ({ verifyPassed: verifyPasses })),
      t('mark_done', 'done'),
    ],
  }
}

async function drive(rounds: ToolCall[][], verifyPasses = true) {
  const { tools, ran } = makeTools(verifyPasses)
  const orch = createOrchestratorAgent({ agent: AGENT, getAdapter: () => scriptedAdapter(rounds), tools })
  const result = await orch.run('do the task')
  return { result, ran }
}

describe('orchestrator agent — guardrails enforced in the loop', () => {
  test('ground-before-act: edit before inspect is blocked, the edit never runs', async () => {
    const { result, ran } = await drive([[tc('edit_code')], [tc('inspect_repo')]])
    expect(ran).not.toContain('edit_code')          // the act was refused
    expect(result.blockedCalls.some(b => b.tool === 'edit_code')).toBe(true)
  })

  test('done before a passing verify is blocked', async () => {
    const { result, ran } = await drive([[tc('inspect_repo')], [tc('edit_code')], [tc('mark_done')]])
    expect(ran).toContain('edit_code')
    expect(ran).not.toContain('mark_done')          // done refused — never verified
    expect(result.blockedCalls.some(b => b.tool === 'mark_done')).toBe(true)
  })

  test('failing verify keeps done blocked', async () => {
    const { ran } = await drive(
      [[tc('inspect_repo')], [tc('edit_code')], [tc('verify')], [tc('mark_done')]],
      false, // verify fails
    )
    expect(ran).toContain('verify')
    expect(ran).not.toContain('mark_done')
  })

  test('happy path: inspect → edit → verify(pass) → done all run', async () => {
    const { result, ran } = await drive(
      [[tc('inspect_repo')], [tc('edit_code')], [tc('verify')], [tc('mark_done')]],
      true,
    )
    expect(ran).toEqual(['inspect_repo', 'edit_code', 'verify', 'mark_done'])
    expect(result.guard.lastVerifyPassed).toBe(true)
    expect(result.blockedCalls).toHaveLength(0)
  })

  test('cannot game it: verify(pass) → edit → done is blocked (edit invalidated the verify)', async () => {
    const { ran, result } = await drive(
      [[tc('inspect_repo')], [tc('verify')], [tc('edit_code')], [tc('mark_done')]],
      true,
    )
    expect(ran).toContain('edit_code')
    expect(ran).not.toContain('mark_done')          // re-verify required after the change
    expect(result.blockedCalls.some(b => b.tool === 'mark_done')).toBe(true)
  })
})

test('same-round edit must finish before verification runs', async () => {
  let edited = false
  let verifiedEditedVersion = false
  const { tools } = makeTools(true)
  const orderedTools = tools.map(tool => ({
    ...tool,
    run: async () => {
      if (tool.kind === 'act') { await Bun.sleep(20); edited = true }
      if (tool.kind === 'verify') verifiedEditedVersion = edited
      return tool.run({})
    },
  }))
  const adapter = scriptedAdapter([[tc('inspect_repo')], [tc('edit_code'), tc('verify')], [tc('mark_done')]])
  const result = await createOrchestratorAgent({ agent: AGENT, getAdapter: () => adapter, tools: orderedTools }).run('do the task')
  expect(verifiedEditedVersion).toBe(true)
  expect(result.guard.lastVerifyPassed).toBe(true)
})
