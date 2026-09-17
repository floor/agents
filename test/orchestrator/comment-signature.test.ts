import { test, expect, describe } from 'bun:test'
import type { TaskAdapter } from '@floor-agents/core'
import { agentLabel, agentSignature, sign, signComments, ENGINE_SIGNATURE } from '../../packages/orchestrator/src/comment-signature.ts'

const agent = (name: string, model: string, provider: string) => ({ name, llm: { model, provider } }) as never

describe('agentLabel', () => {
  test('reads as a person writes it: the transport and the repeated vendor go', () => {
    expect(agentLabel(agent('Grok', 'cursor-grok-4.6-high', 'cursor'))).toBe('Grok 4.6 high')
    expect(agentLabel(agent('Grok', 'cursor-grok-4.6-xhigh-fast', 'cursor'))).toBe('Grok 4.6 xhigh fast')
    expect(agentLabel(agent('Claude', 'opus', 'claude-code'))).toBe('Claude Opus')
    expect(agentLabel(agent('Codex', 'gpt-5-codex', 'codex-cli'))).toBe('Codex GPT 5')
  })

  test('a pinned model keeps its version and drops its release date', () => {
    expect(agentLabel(agent('Claude', 'claude-opus-4-1-20250805', 'claude-code'))).toBe('Claude Opus 4.1')
  })

  test('a model that says nothing beyond the name leaves the name alone', () => {
    expect(agentLabel(agent('Codex', 'codex', 'codex-cli'))).toBe('Codex')
  })
})

describe('signComments', () => {
  const capture = (out: string[]): TaskAdapter => ({
    async *watchIssues() {},
    async getIssue() { return null },
    async createIssue() { throw new Error('unused') },
    async updateIssue() {},
    async addComment(_id: string, text: string) { out.push(text) },
    async setStatus() {},
    async setLabel() {},
    async removeLabel() {},
  } as unknown as TaskAdapter)

  test('every comment says who wrote it, since the account name is the same for all of them', async () => {
    const out: string[] = []
    const signed = signComments(capture(out), agentSignature(agent('Grok', 'cursor-grok-4.6-high', 'cursor'), 'implementer'))
    await signed.addComment('210', '⏳ working on the code...')
    expect(out[0]).toBe('⏳ working on the code...\n\n**Agent:** Grok 4.6 high · implementer')
  })

  test('the role tells two turns of the same model apart', async () => {
    const out: string[] = []
    const grok = agent('Grok', 'cursor-grok-4.6-high', 'cursor')
    await signComments(capture(out), agentSignature(grok, 'implementer')).addComment('1', 'wrote the fix')
    await signComments(capture(out), agentSignature(grok, 'committee member')).addComment('1', 'voted')
    expect(out[0]).toContain('Grok 4.6 high · implementer')
    expect(out[1]).toContain('Grok 4.6 high · committee member')
  })

  test('the engine signs its own turns, and a signature is never doubled', async () => {
    const out: string[] = []
    const signed = signComments(capture(out), ENGINE_SIGNATURE)
    await signed.addComment('1', sign('🏛️ Committee review started', ENGINE_SIGNATURE))
    expect(out[0]!.match(/Floor Agents/g)).toHaveLength(1)
    expect(out[0]).toContain('· engine')
  })
})
