import { test, expect } from 'bun:test'
import { createGitHubAdapter, GitHubError } from '@floor-agents/github'

test('creates adapter', () => {
  const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
  expect(typeof adapter.createBranch).toBe('function')
  expect(typeof adapter.commitFiles).toBe('function')
})

test('rejects creating a branch named main', async () => {
  const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
  await expect(adapter.createBranch('repo', 'main')).rejects.toThrow('protected branch')
})

test('rejects creating a branch named master', async () => {
  const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
  await expect(adapter.createBranch('repo', 'master')).rejects.toThrow('protected branch')
})

test('rejects committing to main', async () => {
  const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
  await expect(
    adapter.commitFiles('repo', 'main', [{ path: 'test.ts', content: 'x' }], 'msg'),
  ).rejects.toThrow('protected branch')
})

test('allows agent branches (past the protection guard, no network)', async () => {
  const realFetch = globalThis.fetch
  // Mock the GitHub API so the test is offline and deterministic — it must fail at
  // the API (mocked 404), NOT at the protection guard.
  globalThis.fetch = (async () => new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch
  try {
    const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
    await adapter.createBranch('repo', 'agent/FLO-5-add-slugify')
    throw new Error('expected createBranch to reject')
  } catch (err) {
    expect((err as GitHubError).message).not.toContain('protected branch')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a branch that already exists is moved to the base, so a retry starts fresh', async () => {
  const realFetch = globalThis.fetch
  const calls: Array<{ method: string; url: string; body?: unknown }> = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (method === 'GET') return new Response(JSON.stringify({ object: { sha: 'base-sha' } }), { status: 200 })
    // The branch is left over from a previous attempt.
    if (method === 'POST') return new Response('{"message":"Reference already exists"}', { status: 422 })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  try {
    const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
    await adapter.createBranch('repo', 'agent/218-retry', 'next')
    const patch = calls.find(c => c.method === 'PATCH')
    expect(patch?.url).toContain('/git/refs/heads/agent/218-retry')
    expect(patch?.body).toEqual({ sha: 'base-sha', force: true })
  } finally {
    globalThis.fetch = realFetch
  }
})
