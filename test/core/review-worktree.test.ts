import { test, expect } from 'bun:test'
import type { GitRunner } from '@floor-agents/core'
import { resolveWorktree, WorktreeMismatchError } from '@floor-agents/core'

// Shared by @floor-agents/codex-cli and @floor-agents/antigravity-cli (see
// each package's own src/worktree.ts wrapper) — these tests cover the
// `label` option itself, which is new behavior added when the second
// package started reusing this function. The rest of the lifecycle
// (fetch/add/verify/cleanup on every path) is already covered exhaustively
// through @floor-agents/codex-cli's own worktree.test.ts and adapter.test.ts,
// which exercise this same shared implementation — not repeated here.

const HEAD_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const CLONE_PATH = '/fake/clone'

// Simulates `worktree add` reporting success while the checkout ends up at
// an unexpected commit (see resolveWorktree's own doc comment) — this makes
// the post-add verification step throw its OWN branded `WorktreeMismatchError`
// (rather than some other error), which is what these label tests target.
function makeMismatchedVerifyGitRunner() {
  let registeredDir: string | undefined

  const runGit: GitRunner = async (args) => {
    if (args.includes('fetch')) return ''
    if (args.includes('worktree') && args.includes('add')) {
      registeredDir = args[5]
      return ''
    }
    if (args.includes('rev-parse')) return 'a-different-sha-than-expected\n'
    if (args.includes('worktree') && args.includes('remove')) return ''
    throw new Error(`unexpected git invocation in test fake: ${args.join(' ')}`)
  }

  return { runGit, getRegisteredDir: () => registeredDir }
}

test('defaults the label to "Reviewer" when none is given', async () => {
  const { runGit } = makeMismatchedVerifyGitRunner()

  await expect(
    resolveWorktree({ headSha: HEAD_SHA, clonePath: CLONE_PATH, worktreeRoot: '/fake/root' }, { runGit }),
  ).rejects.toThrow(/^Reviewer:/)
})

test('a custom label appears in both the error message and the auto-created worktree directory name', async () => {
  const { runGit, getRegisteredDir } = makeMismatchedVerifyGitRunner()

  await expect(
    resolveWorktree(
      { headSha: HEAD_SHA, clonePath: CLONE_PATH, worktreeRoot: '/fake/root', label: 'AntigravityReviewer' },
      { runGit },
    ),
  ).rejects.toThrow(/^AntigravityReviewer:/)

  expect(getRegisteredDir()).toContain('antigravityreviewer-review-')
})

test('a WorktreeMismatchError for a caller-supplied worktreePath is branded with the given label', async () => {
  const runGit: GitRunner = async (args) => {
    if (args.includes('rev-parse')) return 'a-different-sha\n'
    throw new Error(`unexpected git invocation: ${args.join(' ')}`)
  }

  const err = await resolveWorktree(
    { worktreePath: '/fake/worktree', headSha: HEAD_SHA, label: 'CodexReviewer' },
    { runGit },
  ).catch((e) => e)

  expect(err).toBeInstanceOf(WorktreeMismatchError)
  expect((err as Error).message).toContain('CodexReviewer:')
  expect((err as WorktreeMismatchError).expectedSha).toBe(HEAD_SHA)
  expect((err as WorktreeMismatchError).actualSha).toBe('a-different-sha')
})

test('the "no worktreePath and no clonePath" error is branded with the given label', async () => {
  await expect(resolveWorktree({ headSha: HEAD_SHA, label: 'AntigravityReviewer' })).rejects.toThrow(
    /^AntigravityReviewer:.*worktreePath.*clonePath/is,
  )
})

test('a label with characters that are not directory-name-safe is slugified for the worktree dir, without changing the error-message wording', async () => {
  const { runGit, getRegisteredDir } = makeMismatchedVerifyGitRunner()

  await expect(
    resolveWorktree(
      { headSha: HEAD_SHA, clonePath: CLONE_PATH, worktreeRoot: '/fake/root', label: 'Some Weird/Label!!' },
      { runGit },
    ),
  ).rejects.toThrow(/^Some Weird\/Label!!:/)

  expect(getRegisteredDir()).toContain('some-weird-label-review-')
})
