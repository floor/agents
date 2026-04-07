import { test, expect } from 'bun:test'
import { createLMStudioAdapter } from '@floor-agents/lmstudio'

test('creates adapter with default config (localhost:1234)', () => {
  const adapter = createLMStudioAdapter()
  expect(typeof adapter.run).toBe('function')
})

test('creates adapter with custom base URL', () => {
  const adapter = createLMStudioAdapter({
    baseUrl: 'http://192.168.1.100:1234/v1',
  })
  expect(typeof adapter.run).toBe('function')
})

test('creates adapter with API key for remote LM Studio', () => {
  const adapter = createLMStudioAdapter({
    baseUrl: 'https://my-gpu-server.example.com/v1',
    apiKey: 'lms-key-123',
  })
  expect(typeof adapter.run).toBe('function')
})
