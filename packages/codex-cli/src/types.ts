// Mirrors the `Reviewer` interface from `@floor-agents/core`
// (`packages/core/src/types/adapters.ts`), used by the review-and-gate loop:
//
//   export interface Reviewer {
//     vendor: string // "codex"
//     review(input: { repo: string; prNumber: number; headSha: string; worktreePath?: string; prompt: string }): Promise<{ text: string }>
//   }
//
// `core` did not export `Reviewer` on `main` yet when this package was written, so the
// shape is redefined here (as `type`, per this repo's convention of preferring `type`
// over `interface`) to unblock this package. Once core exports `Reviewer`, replace this
// file with a re-export from '@floor-agents/core' — the shape below must stay in sync
// with core's in the meantime.

export type ReviewInput = {
  readonly repo: string
  readonly prNumber: number
  readonly headSha: string
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
