import { test, expect } from 'bun:test'
import { createClaudeCodeAdapter } from '@floor-agents/claude-code'

test('creates adapter with default config', () => {
  const adapter = createClaudeCodeAdapter()
  expect(typeof adapter.run).toBe('function')
})

test('creates adapter with custom config', () => {
  const adapter = createClaudeCodeAdapter({
    cwd: '/tmp',
    model: 'sonnet',
    maxTurns: 5,
    allowedTools: ['Read', 'Grep'],
  })
  expect(typeof adapter.run).toBe('function')
})
