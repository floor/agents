import { test, expect, describe } from 'bun:test'
import { computeRequiredProviders } from '@floor-agents/core'
import type { AgentDefinition } from '@floor-agents/core'

function agent(id: string, provider: string, external = false): AgentDefinition {
  return {
    id,
    name: id,
    promptTemplate: 'agents/committee.md',
    llm: { provider, model: 'm', temperature: 0.3, maxTokens: 100 },
    capabilities: ['vote'],
    autonomy: 'T1',
    customInstructions: '',
    external,
  }
}

describe('computeRequiredProviders', () => {
  test('returns providers of internal agents', () => {
    const got = computeRequiredProviders([agent('a', 'anthropic'), agent('b', 'gemini')])
    expect([...got].sort()).toEqual(['anthropic', 'gemini'])
  })

  test('excludes external agents (they run via the gateway, no key needed)', () => {
    const got = computeRequiredProviders([
      agent('claude', 'claude-code'),
      agent('codex', 'openai', true),
      agent('antigravity', 'gemini', true),
    ])
    expect([...got]).toEqual(['claude-code'])
  })

  test('deduplicates repeated providers', () => {
    const got = computeRequiredProviders([agent('a', 'anthropic'), agent('b', 'anthropic')])
    expect([...got]).toEqual(['anthropic'])
  })

  test('returns an empty set for no internal agents', () => {
    expect(computeRequiredProviders([agent('x', 'openai', true)]).size).toBe(0)
    expect(computeRequiredProviders([]).size).toBe(0)
  })
})
