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
}

export type ReviewResult = {
  readonly text: string
}

export type Reviewer = {
  readonly vendor: string
  review(input: ReviewInput): Promise<ReviewResult>
}
