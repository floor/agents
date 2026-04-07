import { test, expect } from 'bun:test'
import { loadCompanyConfig } from '@floor-agents/core'

test('loads default template', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')

  expect(config.name).toBe('Default Team')
  expect(config.agents.length).toBe(5)
  expect(config.agents.map(a => a.id)).toEqual(['backend', 'frontend', 'pm', 'cto', 'qa'])
  expect(config.workflow.states.length).toBe(8)
  expect(config.chain.nodes.length).toBe(5)
  expect(config.guardrails.maxFilesPerTask).toBe(20)
  expect(config.costs.maxCostPerTask).toBe(5.0)
})

test('throws on missing config file', async () => {
  await expect(loadCompanyConfig('nonexistent.yaml')).rejects.toThrow('Config file not found')
})

test('parses agent definitions correctly', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const backend = config.agents.find(a => a.id === 'backend')!

  expect(backend.name).toBe('Backend Developer')
  expect(backend.llm.provider).toBe('claude-code')
  expect(backend.llm.model).toBe('sonnet')
  expect(backend.llm.temperature).toBe(0.2)
  expect(backend.llm.maxTokens).toBe(16000)
  expect(backend.capabilities).toContain('write_code')
  expect(backend.autonomy).toBe('T1')
})
