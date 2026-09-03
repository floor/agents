// Thin, label-bound wrapper around @floor-agents/core's shared worktree
// lifecycle (extracted there once @floor-agents/antigravity-cli needed
// byte-for-byte the same behavior — see that package's src/worktree.ts for
// its own wrapper, and core's src/review/worktree.ts for the shared
// implementation and full doc comments). Re-exported from this package's
// index.ts so existing callers/tests importing `resolveWorktree`/
// `GitRunner`/`ResolvedWorktree` from `@floor-agents/codex-cli` keep working
// unchanged.

import { resolveWorktree as sharedResolveWorktree } from '@floor-agents/core'
import type { GitRunner, ResolvedWorktree } from '@floor-agents/core'

export type { GitRunner, ResolvedWorktree }

export async function resolveWorktree(
  input: {
    readonly worktreePath?: string
    readonly headSha: string
    readonly clonePath?: string
    readonly worktreeRoot?: string
    readonly mergeBaseSha?: string
  },
  deps: { readonly runGit?: GitRunner } = {},
): Promise<ResolvedWorktree> {
  return sharedResolveWorktree({ ...input, label: 'CodexReviewer' }, deps)
}
