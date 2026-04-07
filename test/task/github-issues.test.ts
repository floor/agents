// @ts-nocheck — fetch mock types don't match Bun's fetch signature
import { test, expect } from 'bun:test'
import { createGitHubIssuesAdapter } from '@floor-agents/task'
import { createTaskAdapter } from '@floor-agents/task'

const config = {
  token: 'test-token',
  owner: 'test-owner',
  repo: 'test-repo',
}

test('createGitHubIssuesAdapter returns valid TaskAdapter shape', () => {
  const adapter = createGitHubIssuesAdapter(config)

  expect(typeof adapter.watchIssues).toBe('function')
  expect(typeof adapter.getIssue).toBe('function')
  expect(typeof adapter.createIssue).toBe('function')
  expect(typeof adapter.updateIssue).toBe('function')
  expect(typeof adapter.addComment).toBe('function')
  expect(typeof adapter.setStatus).toBe('function')
  expect(typeof adapter.setLabel).toBe('function')
  expect(typeof adapter.removeLabel).toBe('function')
})

test('factory creates github-issues adapter', () => {
  const adapter = createTaskAdapter({ type: 'github-issues', githubIssues: config })

  expect(typeof adapter.watchIssues).toBe('function')
  expect(typeof adapter.getIssue).toBe('function')
  expect(typeof adapter.createIssue).toBe('function')
  expect(typeof adapter.updateIssue).toBe('function')
  expect(typeof adapter.addComment).toBe('function')
  expect(typeof adapter.setStatus).toBe('function')
  expect(typeof adapter.setLabel).toBe('function')
  expect(typeof adapter.removeLabel).toBe('function')
})

test('githubStateToStatus: open maps to triage', () => {
  // We test the mapping indirectly by converting a mock issue response
  // and verifying the status field on the returned Issue
  const mockFetch = globalThis.fetch

  let callCount = 0
  globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
    callCount++
    const mockIssue = {
      number: 42,
      title: 'Test issue',
      body: 'Body text',
      state: 'open',
      labels: [{ name: 'floor' }],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    }
    return new Response(JSON.stringify(mockIssue), { status: 200 })
  }

  const adapter = createGitHubIssuesAdapter(config)

  const result = adapter.getIssue('42').then(issue => {
    expect(issue).not.toBeNull()
    expect(issue!.id).toBe('42')
    expect(issue!.title).toBe('Test issue')
    expect(issue!.status).toBe('triage')
    expect(issue!.labels).toEqual(['floor'])
  }).finally(() => {
    globalThis.fetch = mockFetch
  })

  return result
})

test('githubStateToStatus: closed maps to done', () => {
  const mockFetch = globalThis.fetch

  globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const mockIssue = {
      number: 7,
      title: 'Closed issue',
      body: null,
      state: 'closed',
      labels: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-03T00:00:00Z',
    }
    return new Response(JSON.stringify(mockIssue), { status: 200 })
  }

  const adapter = createGitHubIssuesAdapter(config)

  return adapter.getIssue('7').then(issue => {
    expect(issue).not.toBeNull()
    expect(issue!.status).toBe('done')
    expect(issue!.body).toBe('')
  }).finally(() => {
    globalThis.fetch = mockFetch
  })
})

test('getIssue returns null on API error', () => {
  const mockFetch = globalThis.fetch

  globalThis.fetch = async () => {
    return new Response('Not Found', { status: 404 })
  }

  const adapter = createGitHubIssuesAdapter(config)

  return adapter.getIssue('999').then(issue => {
    expect(issue).toBeNull()
  }).finally(() => {
    globalThis.fetch = mockFetch
  })
})
