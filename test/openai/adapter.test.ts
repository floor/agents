import { test, expect } from 'bun:test'
import { createOpenAIAdapter } from '@floor-agents/openai'

test('creates adapter without config (defaults to OpenAI)', () => {
  const adapter = createOpenAIAdapter()
  expect(typeof adapter.run).toBe('function')
})

test('creates adapter with LM Studio config', () => {
  const adapter = createOpenAIAdapter({
    baseUrl: 'http://localhost:1234/v1',
  })
  expect(typeof adapter.run).toBe('function')
})

test('creates adapter with API key for remote provider', () => {
  const adapter = createOpenAIAdapter({
    apiKey: 'sk-test',
    baseUrl: 'https://api.together.xyz/v1',
  })
  expect(typeof adapter.run).toBe('function')
})
