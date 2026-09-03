// ── Reviewer Adapter (review & gate mode) ─────────────────────────────
//
// A Reviewer wraps one independent-vendor review tool (Codex CLI, Gemini
// CLI, etc). The gate loop calls `review()` once per PR head that needs a
// review and posts the returned `text` verbatim as a PR comment — it is
// never edited, summarized, or otherwise transformed. `vendor` is compared
// against the PR's implementer vendor (see gate/vendor.ts) to enforce the
// "different vendor" review rule from the review-and-gate protocol.

export type ReviewInput = {
  readonly repo: string
  readonly prNumber: string
  readonly headSha: string
  /** Path to a local worktree checked out at `headSha`, if the reviewer
   *  needs direct filesystem access (e.g. a CLI tool). Optional — a
   *  reviewer that only needs the diff/prompt text can ignore this. */
  readonly worktreePath?: string
  readonly prompt: string
  /** The PR's merge-base commit sha, when the caller resolved one (see
   *  `CompareResult.mergeBaseSha` and `gate/loop.ts`, which is the only
   *  current caller that sets this). A reviewer that creates its own
   *  worktree (codex-cli, antigravity-cli) fetches this object into it —
   *  see `ResolveWorktreeInput.mergeBaseSha` in
   *  `packages/core/src/review/worktree.ts` for why that's needed at
   *  all. Optional and best-effort throughout: a reviewer that doesn't
   *  use a local worktree can ignore this entirely, and a reviewer that
   *  does still works without it, just with the same "unknown revision"
   *  failure mode this field exists to avoid. */
  readonly mergeBaseSha?: string
  /** Shell command(s) a worktree-creating reviewer should run, each from
   *  `<worktree>/<pathPrefix>`, before reviewing (floor/agents#32) — e.g.
   *  a package install, so the reviewer's own later commands (`bun test`,
   *  `bun run typecheck`) have something to run against instead of
   *  failing on a missing `node_modules` every time. Selected by the
   *  caller (`gate/loop.ts`'s `selectPrepareCommands`, from
   *  `GateModeConfig.prepare`) from the PR's changed files — this field
   *  is already the resolved list to run, not raw config. A reviewer
   *  that doesn't create a local worktree (or doesn't need dependencies
   *  installed) can ignore this entirely; one that does MUST run each
   *  step best-effort (never let a failure abort the review) and MUST
   *  exclude each step's own output from the prompt it sends — see
   *  `@floor-agents/codex-cli`'s adapter for the reference
   *  implementation (caching by lockfile hash, a timeout per step, and a
   *  one-line failure note prepended to the prompt instead). */
  readonly prepareSteps?: readonly PrepareStep[]
  /** Per-step timeout for `prepareSteps`, in ms. Optional — a reviewer
   *  that supports `prepareSteps` should fall back to its own sane
   *  default when this is unset (never wait forever). */
  readonly prepareTimeoutMs?: number
}

/** One `pathPrefix` -> `command` pair from `ReviewInput.prepareSteps` —
 *  see that field's own doc comment. `pathPrefix` is relative to the
 *  worktree root (e.g. `"web/"`, or `""` to run at the worktree root
 *  itself). */
export type PrepareStep = {
  readonly pathPrefix: string
  readonly command: string
}

export type ReviewResult = {
  readonly text: string
}

export type Reviewer = {
  readonly vendor: string
  review(input: ReviewInput): Promise<ReviewResult>
}
