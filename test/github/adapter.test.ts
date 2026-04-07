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

test('allows agent branches', async () => {
  const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
  // This will fail with a network error (no real GitHub) but NOT with a protection error
  try {
    await adapter.createBranch('repo', 'agent/FLO-5-add-slugify')
  } catch (err) {
    expect((err as GitHubError).message).not.toContain('protected branch')
  }
})
