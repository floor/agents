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

// ── mergeBaseSha (floor/radiooooo #130 round 22: the merge-base commit ──
// object must actually be fetched into the clone, or the reviewer's own
// `git diff {{mergeBase}}...{{headSha}}` fails with "unknown revision") ──

const MERGE_BASE_SHA = 'cafef00dcafef00dcafef00dcafef00dcafef00d'

function makeTrackingGitRunner() {
  const fetchedRefs: string[] = []
  const calls: (readonly string[])[] = []

  const runGit: GitRunner = async (args) => {
    calls.push(args)
    if (args.includes('fetch')) {
      // ['-C', clonePath, 'fetch', 'origin', ref]
      fetchedRefs.push(args[4]!)
      return ''
    }
    if (args.includes('worktree') && args.includes('add')) return ''
    if (args.includes('rev-parse')) return `${HEAD_SHA}\n`
    if (args.includes('worktree') && args.includes('remove')) return ''
    throw new Error(`unexpected git invocation in test fake: ${args.join(' ')}`)
  }

  return { runGit, fetchedRefs, calls }
}

test('mergeBaseSha is fetched as its own `git fetch`, separate from and after headSha\'s, before worktree add', async () => {
  const { runGit, fetchedRefs, calls } = makeTrackingGitRunner()

  const worktree = await resolveWorktree(
    { headSha: HEAD_SHA, clonePath: CLONE_PATH, worktreeRoot: '/fake/root', mergeBaseSha: MERGE_BASE_SHA },
    { runGit },
  )
  await worktree.cleanup()

  expect(fetchedRefs).toEqual([HEAD_SHA, MERGE_BASE_SHA])
  const addIndex = calls.findIndex((args) => args.includes('worktree') && args.includes('add'))
  const mergeBaseFetchIndex = calls.findIndex((args) => args.includes('fetch') && args.includes(MERGE_BASE_SHA))
  expect(mergeBaseFetchIndex).toBeGreaterThanOrEqual(0)
  expect(mergeBaseFetchIndex).toBeLessThan(addIndex)
})

test('mergeBaseSha is NOT fetched again when it equals headSha (already covered by that fetch)', async () => {
  const { runGit, fetchedRefs } = makeTrackingGitRunner()

  const worktree = await resolveWorktree(
    { headSha: HEAD_SHA, clonePath: CLONE_PATH, worktreeRoot: '/fake/root', mergeBaseSha: HEAD_SHA },
    { runGit },
  )
  await worktree.cleanup()

  expect(fetchedRefs).toEqual([HEAD_SHA])
})

test('mergeBaseSha is not fetched at all when unset (existing behavior unchanged)', async () => {
  const { runGit, fetchedRefs } = makeTrackingGitRunner()

  const worktree = await resolveWorktree(
    { headSha: HEAD_SHA, clonePath: CLONE_PATH, worktreeRoot: '/fake/root' },
    { runGit },
  )
  await worktree.cleanup()

  expect(fetchedRefs).toEqual([HEAD_SHA])
})

test('a mergeBaseSha fetch failure is swallowed — the review still gets a worktree, unlike a headSha fetch failure', async () => {
  const calls: (readonly string[])[] = []
  const runGit: GitRunner = async (args) => {
    calls.push(args)
    if (args.includes('fetch') && args.includes(MERGE_BASE_SHA)) {
      throw new Error('simulated: mergeBaseSha unreachable on this remote')
    }
    if (args.includes('fetch')) return '' // the headSha fetch
    if (args.includes('worktree') && args.includes('add')) return ''
    if (args.includes('rev-parse')) return `${HEAD_SHA}\n`
    if (args.includes('worktree') && args.includes('remove')) return ''
    throw new Error(`unexpected git invocation in test fake: ${args.join(' ')}`)
  }

  const worktree = await resolveWorktree(
    { headSha: HEAD_SHA, clonePath: CLONE_PATH, worktreeRoot: '/fake/root', mergeBaseSha: MERGE_BASE_SHA },
    { runGit },
  )

  expect(worktree.cwd).toBeTruthy()
  expect(calls.some((args) => args.includes('worktree') && args.includes('add'))).toBe(true)
  await worktree.cleanup()
})

test('a mergeBaseSha fetch failure does not trigger cleanup — only headSha-fetch/add/verify failures do', async () => {
  const calls: (readonly string[])[] = []
  let removeCalled = false
  const runGit: GitRunner = async (args) => {
    calls.push(args)
    if (args.includes('fetch') && args.includes(MERGE_BASE_SHA)) {
      throw new Error('simulated: mergeBaseSha unreachable on this remote')
    }
    if (args.includes('fetch')) return ''
    if (args.includes('worktree') && args.includes('add')) return ''
    if (args.includes('rev-parse')) return `${HEAD_SHA}\n`
    if (args.includes('worktree') && args.includes('remove')) {
      removeCalled = true
      return ''
    }
    throw new Error(`unexpected git invocation in test fake: ${args.join(' ')}`)
  }

  const worktree = await resolveWorktree(
    { headSha: HEAD_SHA, clonePath: CLONE_PATH, worktreeRoot: '/fake/root', mergeBaseSha: MERGE_BASE_SHA },
    { runGit },
  )

  // Cleanup was never triggered by the swallowed mergeBaseSha failure — resolveWorktree
  // returned normally, so cleanup only runs when THIS test calls it explicitly below.
  expect(removeCalled).toBe(false)
  await worktree.cleanup()
  expect(removeCalled).toBe(true)
})
