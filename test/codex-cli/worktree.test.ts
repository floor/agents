import { test, expect } from 'bun:test'
import type { GitRunner } from '@floor-agents/codex-cli'
import { resolveWorktree } from '@floor-agents/codex-cli'

const HEAD_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const CLONE_PATH = '/fake/clone'

/**
 * A fake `GitRunner` that never spawns real git: `fetch` and `worktree add` always
 * succeed (recording the created directory as "registered"), the post-add
 * `rev-parse HEAD` verification step throws (simulating the worktree ending up in an
 * unexpected state after a successful `add`), and `worktree remove` records which
 * directory it was asked to remove. This lets the cleanup-on-verification-failure
 * path be tested deterministically, without relying on a filesystem trick to make a
 * real `git worktree add` fail (which can't distinguish "add failed" from "add
 * succeeded but something after it failed").
 */
function makeFailOnVerifyGitRunner() {
  const calls: (readonly string[])[] = []
  let registeredDir: string | undefined
  let removedDir: string | undefined

  const runGit: GitRunner = async (args) => {
    calls.push(args)

    if (args.includes('fetch')) {
      return ''
    }

    if (args.includes('worktree') && args.includes('add')) {
      // ['-C', clonePath, 'worktree', 'add', '--detach', dir, sha]
      registeredDir = args[5]
      return ''
    }

    if (args.includes('rev-parse')) {
      throw new Error('simulated post-add verification failure: worktree checkout never completed')
    }

    if (args.includes('worktree') && args.includes('remove')) {
      // ['-C', clonePath, 'worktree', 'remove', '--force', dir]
      removedDir = args[5]
      return ''
    }

    throw new Error(`unexpected git invocation in test fake: ${args.join(' ')}`)
  }

  return {
    runGit,
    calls,
    getRegisteredDir: () => registeredDir,
    getRemovedDir: () => removedDir,
  }
}

test('cleans up (worktree remove) when a step after a successful worktree add fails', async () => {
  const { runGit, getRegisteredDir, getRemovedDir } = makeFailOnVerifyGitRunner()

  await expect(
    resolveWorktree({ headSha: HEAD_SHA, clonePath: CLONE_PATH, worktreeRoot: '/fake/root' }, { runGit }),
  ).rejects.toThrow(/simulated post-add verification failure/)

  const registered = getRegisteredDir()
  expect(registered).toBeTruthy()
  // Proves cleanup ran specifically for the directory that `worktree add` actually
  // registered — not a no-op, and not some other path.
  expect(getRemovedDir()).toBe(registered)
})

test('never attempts git worktree remove if worktree add itself never ran (fetch failure) — cleanup goes straight to a filesystem removal', async () => {
  const calls: (readonly string[])[] = []
  const runGit: GitRunner = async (args) => {
    calls.push(args)
    if (args.includes('fetch')) {
      throw new Error('simulated fetch failure')
    }
    // If cleanup ever calls `worktree remove` here, that's the bug this test pins —
    // fail loudly rather than silently returning '' and letting it slide.
    throw new Error(`unexpected git invocation in test fake: ${args.join(' ')}`)
  }

  await expect(
    resolveWorktree({ headSha: HEAD_SHA, clonePath: CLONE_PATH, worktreeRoot: '/fake/root' }, { runGit }),
  ).rejects.toThrow(/simulated fetch failure/)

  expect(calls.some((args) => args.includes('worktree') && args.includes('add'))).toBe(false)
  // The actual behavior this test name promises: cleanup must not attempt
  // `git worktree remove` for a directory `worktree add` never registered.
  expect(calls.some((args) => args.includes('worktree') && args.includes('remove'))).toBe(false)
})

test('the default GitRunner is used when none is injected (integration smoke test)', async () => {
  // Sanity check that omitting `deps` doesn't crash before it even gets to running
  // git — a bad clonePath should fail during the real `git fetch`, proving the
  // default runner path is reachable and produces a real error, not a silent no-op.
  await expect(
    resolveWorktree({ headSha: HEAD_SHA, clonePath: '/definitely/does/not/exist', worktreeRoot: '/fake/root' }),
  ).rejects.toThrow()
})
