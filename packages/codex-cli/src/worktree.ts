import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ResolvedWorktree = {
  readonly cwd: string
  /** Best-effort cleanup. Safe to call even if the worktree was never fully created. */
  readonly cleanup: () => Promise<void>
}

const NOOP_CLEANUP = async () => {}

/**
 * Resolves the working directory to run Codex in. If `worktreePath` is given, it is
 * used as-is and never removed by this package (the caller owns its lifecycle).
 * Otherwise, a detached worktree is created at `headSha` from `clonePath` under
 * `worktreeRoot`, and `cleanup()` removes it. The clone at `clonePath` itself is never
 * run in directly and never mutated beyond `fetch` + `worktree add`.
 */
export async function resolveWorktree(input: {
  readonly worktreePath?: string
  readonly headSha: string
  readonly clonePath?: string
  readonly worktreeRoot?: string
}): Promise<ResolvedWorktree> {
  if (input.worktreePath) {
    return { cwd: input.worktreePath, cleanup: NOOP_CLEANUP }
  }

  if (!input.clonePath) {
    throw new Error(
      'CodexReviewer: review() was called without a worktreePath, and no `clonePath` was configured to create one from.',
    )
  }

  const clonePath = input.clonePath
  const root = input.worktreeRoot ?? tmpdir()
  const dir = join(root, `codex-review-${randomUUID()}`)

  await Bun.$`git -C ${clonePath} fetch origin ${input.headSha}`.quiet()
  await Bun.$`git -C ${clonePath} worktree add --detach ${dir} ${input.headSha}`.quiet()

  return {
    cwd: dir,
    cleanup: async () => {
      try {
        await Bun.$`git -C ${clonePath} worktree remove --force ${dir}`.quiet()
      } catch {
        // The worktree may never have been fully registered (e.g. we failed right
        // after `worktree add`), or git may refuse for other reasons. Fall back to
        // removing the directory directly so we never leak a temp dir.
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}
