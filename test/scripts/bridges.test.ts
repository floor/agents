import { test, expect, describe } from 'bun:test'
import { bridgeFor } from '../../scripts/lib/bridges.ts'
import { hasVerdict, reviewWithRetry, buildCursorReviewPrompt } from '../../scripts/lib/cursor-review.ts'

const agent = (id: string, provider: string, model = 'local') => ({ id, name: id, external: true, llm: { provider, model, temperature: 0.3, maxTokens: 16000 } })

describe('bridgeFor — provider picks the bridge', () => {
  test('cursor runs the Cursor bridge with the manifest model and agent id', () => {
    const plan = bridgeFor(agent('grok-reviewer', 'cursor', 'cursor-grok-4.6-high'), '/code/vlist')
    expect(plan.script).toBe('cursor-agent-bridge.ts')
    expect(plan.env).toMatchObject({ AGENT_ID: 'grok-reviewer', CURSOR_MODEL: 'cursor-grok-4.6-high', REVIEW_CWD: '/code/vlist' })
  })

  test('any id can use any transport: GPT through Cursor needs no new code', () => {
    const plan = bridgeFor(agent('gpt', 'cursor', 'gpt-5'), '/code/vlist')
    expect(plan.script).toBe('cursor-agent-bridge.ts')
    expect(plan.env.CURSOR_MODEL).toBe('gpt-5')
  })

  test('grok-cli keeps the xAI bridge available per project', () => {
    const plan = bridgeFor(agent('grok', 'grok-cli'), '/code/vlist')
    expect(plan.script).toBe('grok-agent.ts')
    expect(plan.env).toEqual({ AGENT_ID: 'grok', GROK_CWD: '/code/vlist' })
  })

  test('codex-cli passes a real model through and omits the placeholder', () => {
    expect(bridgeFor(agent('codex', 'codex-cli', 'gpt-5-codex'), '/r').env.CODEX_MODEL).toBe('gpt-5-codex')
    expect(bridgeFor(agent('codex', 'codex-cli'), '/r').env.CODEX_MODEL).toBeUndefined()
  })

  test('older manifests that named a vendor still resolve by agent id', () => {
    expect(bridgeFor(agent('codex', 'openai'), '/r').script).toBe('codex-agent.ts')
    expect(bridgeFor(agent('grok', 'openai'), '/r').script).toBe('grok-agent.ts')
    expect(bridgeFor(agent('antigravity', 'gemini'), '/r').script).toBe('antigravity-relay.ts')
  })

  test('an unknown transport fails before anything starts', () => {
    expect(() => bridgeFor(agent('gpt', 'openai'), '/r')).toThrow(/No bridge for external agent "gpt"/)
  })

  test('cursor without a model is refused rather than using some default', () => {
    expect(() => bridgeFor(agent('grok', 'cursor'), '/r')).toThrow(/names no model/)
  })
})

describe('cursor review', () => {
  test('recognises both committees\' verdict lines', () => {
    expect(hasVerdict('analysis…\n**VOTE: APPROVE**')).toBe(true)
    expect(hasVerdict('VOTE: reject')).toBe(true)
    expect(hasVerdict('RECOMMEND: B')).toBe(true)
    expect(hasVerdict("I'll review the proposal now.")).toBe(false)
  })

  test('retries once when a reply carries no verdict', async () => {
    const replies = ["I'll review it now.", 'Found issues.\nVOTE: REJECT']
    let calls = 0
    const out = await reviewWithRetry(async () => replies[calls++]!)
    expect(calls).toBe(2)
    expect(out).toContain('VOTE: REJECT')
  })

  test('returns the empty reply after the retry, so the committee abstains', async () => {
    let calls = 0
    const out = await reviewWithRetry(async () => { calls++; return 'nothing to say' })
    expect(calls).toBe(2)
    expect(hasVerdict(out)).toBe(false)
  })

  test('the prompt tells the reviewer it cannot modify anything', () => {
    const prompt = buildCursorReviewPrompt({ title: 'T', body: 'B', systemPrompt: 'S' })
    expect(prompt).toContain('you cannot modify anything')
  })
})
