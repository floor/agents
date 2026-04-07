import { test, expect } from 'bun:test'
import { createTaskAdapter, createThingsAdapter } from '@floor-agents/task'

test('factory creates Things adapter', () => {
  const adapter = createTaskAdapter({ type: 'things' })

  expect(typeof adapter.watchIssues).toBe('function')
  expect(typeof adapter.getIssue).toBe('function')
  expect(typeof adapter.createIssue).toBe('function')
  expect(typeof adapter.updateIssue).toBe('function')
  expect(typeof adapter.addComment).toBe('function')
  expect(typeof adapter.setStatus).toBe('function')
  expect(typeof adapter.setLabel).toBe('function')
  expect(typeof adapter.removeLabel).toBe('function')
})

test('direct createThingsAdapter returns valid TaskAdapter', () => {
  const adapter = createThingsAdapter()

  expect(typeof adapter.watchIssues).toBe('function')
  expect(typeof adapter.getIssue).toBe('function')
  expect(typeof adapter.createIssue).toBe('function')
  expect(typeof adapter.updateIssue).toBe('function')
  expect(typeof adapter.addComment).toBe('function')
  expect(typeof adapter.setStatus).toBe('function')
  expect(typeof adapter.setLabel).toBe('function')
  expect(typeof adapter.removeLabel).toBe('function')
})

test('factory throws on unknown type', () => {
  expect(() => createTaskAdapter({ type: 'jira' } as any)).toThrow('Unknown task adapter type')
})
