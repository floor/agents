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
  globalThis.fetch = (async () => new Response('{"message":"Not Found"}', { status: 404 })) as typeof fetch
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
