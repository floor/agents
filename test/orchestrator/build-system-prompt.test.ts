import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSystemPrompt } from '@floor-agents/orchestrator'
import type { AgentDefinition, CompanyConfig } from '@floor-agents/core'

const dir = mkdtempSync(join(tmpdir(), 'prompt-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function promptFile(name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

function agent(over: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'a', name: 'Agent A', promptTemplate: join(dir, 'missing.md'),
    llm: { provider: 'anthropic', model: 'm', temperature: 0.3, maxTokens: 100 },
    capabilities: ['vote'], autonomy: 'T1', customInstructions: '', external: false,
    ...over,
  }
}

const company = (customInstructions = ''): CompanyConfig =>
  ({ project: { customInstructions } } as unknown as CompanyConfig)

describe('buildSystemPrompt', () => {
  test('loads the agent persona from its promptTemplate', async () => {
    const a = agent({ promptTemplate: promptFile('persona.md', 'You are a browser-engine expert.') })
    const prompt = await buildSystemPrompt(a, company())
    expect(prompt).toContain('You are a browser-engine expert.')
  })

  test('falls back to a generic prompt when the template is missing', async () => {
    const prompt = await buildSystemPrompt(agent({ name: 'Codex' }), company())
    expect(prompt).toContain('You are Codex, a technical committee member')
  })

  test('appends project and agent custom instructions', async () => {
    const a = agent({
      promptTemplate: promptFile('p.md', 'BASE'),
      customInstructions: 'Be skeptical of rewrites.',
    })
    const prompt = await buildSystemPrompt(a, company('Zero allocations on the hot path.'))
    expect(prompt).toContain('BASE')
    expect(prompt).toContain('## Project Context')
    expect(prompt).toContain('Zero allocations on the hot path.')
    expect(prompt).toContain('## Agent-Specific Instructions')
    expect(prompt).toContain('Be skeptical of rewrites.')
  })

  test('omits context sections when instructions are empty', async () => {
    const prompt = await buildSystemPrompt(agent({ promptTemplate: promptFile('q.md', 'BASE') }), company())
    expect(prompt).toBe('BASE')
  })

  test('different agents get different personas (no shared generic prompt)', async () => {
    const codex = agent({ id: 'codex', promptTemplate: promptFile('codex.md', 'Pragmatic migration risk lens.') })
    const ag = agent({ id: 'antigravity', promptTemplate: promptFile('ag.md', 'Compositor and touch momentum lens.') })
    const [pc, pa] = await Promise.all([buildSystemPrompt(codex, company()), buildSystemPrompt(ag, company())])
    expect(pc).toContain('Pragmatic migration risk lens.')
    expect(pa).toContain('Compositor and touch momentum lens.')
    expect(pc).not.toEqual(pa)
  })
})
