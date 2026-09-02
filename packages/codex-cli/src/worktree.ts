import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeMismatchError } from './errors'

export type ResolvedWorktree = {
  readonly cwd: string
  /** Best-effort cleanup. Safe to call even if the worktree was never fully created. */
  readonly cleanup: () => Promise<void>
}

/**
 * Runs one git invocation and returns its stdout. `args` excludes the leading `git` —
 * e.g. `['-C', clonePath, 'fetch', 'origin', sha]`. Injectable so tests can simulate
 * git failing (or succeeding with an unexpected result) at a specific step without
 * spawning a real git process.
 */
export type GitRunner = (args: readonly string[]) => Promise<string>

const defaultGitRunner: GitRunner = async (args) => {
  const result = await Bun.$`git ${args}`.quiet()
  return result.stdout.toString()
}

const NOOP_CLEANUP = async () => {}

/**
 * Resolves the working directory to run Codex in. If `worktreePath` is given, it is
 * verified (`git rev-parse HEAD` there must equal `headSha`, throwing typed
 * `WorktreeMismatchError` before anything spawns if it doesn't) and then used as-is —
 * this package never removes a caller-supplied path, on any path through this
 * function, since the caller owns its lifecycle. Otherwise, a detached worktree is
 * created at `headSha` from `clonePath` under `worktreeRoot`, and `cleanup()` removes
 * it. The clone at `clonePath` itself is never run in directly and never mutated
 * beyond `fetch` + `worktree add`.
 */
export async function resolveWorktree(
  input: {
    readonly worktreePath?: string
    readonly headSha: string
    readonly clonePath?: string
    readonly worktreeRoot?: string
  },
  deps: { readonly runGit?: GitRunner } = {},
): Promise<ResolvedWorktree> {
  if (input.worktreePath) {
    const runGit = deps.runGit ?? defaultGitRunner
    // A caller-supplied worktree is just as capable of silently pointing at the wrong
    // commit as one this package creates itself — verify it the same way, before
    // spawning codex, rather than trusting the caller's claim.
    await verifyWorktreeHead(runGit, input.worktreePath, input.headSha)
    return { cwd: input.worktreePath, cleanup: NOOP_CLEANUP }
  }

  if (!input.clonePath) {
    throw new Error(
      'CodexReviewer: review() was called without a worktreePath, and no `clonePath` was configured to create one from.',
    )
  }

  const runGit = deps.runGit ?? defaultGitRunner
  const clonePath = input.clonePath
  const root = input.worktreeRoot ?? tmpdir()
  const dir = join(root, `codex-review-${randomUUID()}`)

  // Only true once `git worktree add` itself has succeeded — i.e. `dir` is actually
  // registered as a worktree of `clonePath`. Cleanup uses this to decide whether
  // attempting `git worktree remove` makes sense at all: if `add` never ran (e.g.
  // `fetch` failed first), there is nothing registered to remove, and issuing that
  // command would just fail (harmlessly, but needlessly) before falling back anyway.
  let registered = false

  const cleanup = async () => {
    if (registered) {
      try {
        await runGit(['-C', clonePath, 'worktree', 'remove', '--force', dir])
        return
      } catch {
        // git may refuse for reasons beyond registration (e.g. it was already removed
        // by something else). Fall through to a direct filesystem cleanup below.
      }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  try {
    await runGit(['-C', clonePath, 'fetch', 'origin', input.headSha])
    await runGit(['-C', clonePath, 'worktree', 'add', '--detach', dir, input.headSha])
    registered = true
    // `worktree add` can report success while the worktree ends up in an unexpected
    // state in rare interrupted cases. Verify it actually checked out the commit we
    // asked for before handing it to codex — reviewing the wrong commit silently
    // would be worse than failing loudly here.
    await verifyWorktreeHead(runGit, dir, input.headSha)
  } catch (err) {
    // Whether `fetch`, `worktree add`, or the verification above threw, the caller
    // never gets a chance to call `cleanup()` in this path, since `resolveWorktree()`
    // never returned. Best-effort clean up whatever exists before rethrowing.
    await cleanup().catch(() => {})
    throw err
  }

  return { cwd: dir, cleanup }
}

async function verifyWorktreeHead(runGit: GitRunner, dir: string, expectedSha: string): Promise<void> {
  const output = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
  const actualSha = output.trim()

  if (actualSha !== expectedSha) {
    throw new WorktreeMismatchError(
      `CodexReviewer: worktree at ${dir} checked out "${actualSha || '(empty)'}", expected "${expectedSha}" — refusing to review the wrong commit.`,
      dir,
      expectedSha,
      actualSha,
    )
  }
}
