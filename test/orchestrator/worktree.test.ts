import { test, expect, beforeEach, afterEach } from 'bun:test'
import { createWorktree, commitAndPushWorktree, removeWorktree } from '@floor-agents/orchestrator'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const TEST_REMOTE = '/tmp/test-worktree-remote'
const TEST_REPO = '/tmp/test-worktree-repo'
const originalCwd = process.cwd()

beforeEach(async () => {
  await rm(TEST_REMOTE, { recursive: true, force: true })
  await rm(TEST_REPO, { recursive: true, force: true })

  // Create a bare remote repo
  await mkdir(TEST_REMOTE, { recursive: true })
  await Bun.$`git -C ${TEST_REMOTE} init --bare`.quiet()

  // Clone it as our working repo
  await Bun.$`git clone ${TEST_REMOTE} ${TEST_REPO}`.quiet()
  await Bun.$`git -C ${TEST_REPO} config user.email "test@test.com"`.quiet()
  await Bun.$`git -C ${TEST_REPO} config user.name "Test"`.quiet()
  await writeFile(join(TEST_REPO, 'README.md'), '# Test')
  await Bun.$`git -C ${TEST_REPO} add -A`.quiet()
  await Bun.$`git -C ${TEST_REPO} commit -m "init"`.quiet()
  await Bun.$`git -C ${TEST_REPO} push origin main`.quiet()

  // Create the agent branch
  await Bun.$`git -C ${TEST_REPO} checkout -b agent/test-branch`.quiet()
  await Bun.$`git -C ${TEST_REPO} push origin agent/test-branch`.quiet()
  await Bun.$`git -C ${TEST_REPO} checkout main`.quiet()

  process.chdir(TEST_REPO)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(TEST_REPO, { recursive: true, force: true })
  await rm(TEST_REMOTE, { recursive: true, force: true })
})

test('creates and removes a worktree', async () => {
  const worktree = await createWorktree('agent/test-branch')

  expect(worktree.path).toContain('agent-test-branch')
  expect(worktree.branch).toBe('agent/test-branch')

  const exists = await Bun.file(join(worktree.path, 'README.md')).exists()
  expect(exists).toBe(true)

  await removeWorktree(worktree)
})

test('commits and pushes changes', async () => {
  const worktree = await createWorktree('agent/test-branch')

  // No changes yet
  const noSha = await commitAndPushWorktree(worktree, 'no changes')
  expect(noSha).toBeNull()

  // Make a change
  await writeFile(join(worktree.path, 'new-file.ts'), 'export const x = 1')

  const sha = await commitAndPushWorktree(worktree, 'add new file')
  expect(sha).not.toBeNull()
  expect(sha!.length).toBeGreaterThan(6)

  await removeWorktree(worktree)
})

test('handles double remove gracefully', async () => {
  const worktree = await createWorktree('agent/test-branch')
  await removeWorktree(worktree)
  await removeWorktree(worktree) // should not throw
})

test('a worktree follows a remote branch that was moved back, even if the clone had fetched the old tip', async () => {
  // A retry force-resets the agent branch to the base. A clone that had
  // already fetched the old tip (someone reviewed the PR) used to refuse the
  // update as a non-fast-forward, and the run died on `git fetch failed`.
  const base = (await Bun.$`git -C ${TEST_REPO} rev-parse main`.text()).trim()
  await Bun.$`git -C ${TEST_REPO} checkout agent/test-branch`.quiet()
  await writeFile(join(TEST_REPO, 'attempt.txt'), 'first attempt')
  await Bun.$`git -C ${TEST_REPO} add -A`.quiet()
  await Bun.$`git -C ${TEST_REPO} commit -m "attempt"`.quiet()
  await Bun.$`git -C ${TEST_REPO} push origin agent/test-branch`.quiet()
  await Bun.$`git -C ${TEST_REPO} checkout main`.quiet()
  // The remote moves the branch back to the base; the clone still tracks the old tip.
  await Bun.$`git -C ${TEST_REMOTE} update-ref refs/heads/agent/test-branch ${base}`.quiet()

  const worktree = await createWorktree('agent/test-branch')
  expect(worktree.initialSha).toBe(base)
  expect(await Bun.file(join(worktree.path, 'attempt.txt')).exists()).toBe(false)
  await removeWorktree(worktree)
})

