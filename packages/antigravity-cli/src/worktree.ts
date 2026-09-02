// Thin, label-bound wrapper around @floor-agents/core's shared worktree
// lifecycle (see @floor-agents/codex-cli's own src/worktree.ts for the
// sibling wrapper, and core's src/review/worktree.ts for the shared
// implementation and full doc comments) — this package never duplicates
// that ~100-line lifecycle, only binds its own label to it.

import { resolveWorktree as sharedResolveWorktree } from '@floor-agents/core'
import type { GitRunner, ResolvedWorktree } from '@floor-agents/core'

export type { GitRunner, ResolvedWorktree }

export async function resolveWorktree(
  input: {
    readonly worktreePath?: string
    readonly headSha: string
    readonly clonePath?: string
    readonly worktreeRoot?: string
  },
  deps: { readonly runGit?: GitRunner } = {},
): Promise<ResolvedWorktree> {
  return sharedResolveWorktree({ ...input, label: 'AntigravityReviewer' }, deps)
}
