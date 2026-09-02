import type { Reviewer, ReviewInput } from '../types/reviewer.ts'

export type FakeReviewerConfig = {
  /** Defaults to 'fake'. Set this to exercise vendor-attribution/vendor-diff
   *  logic in tests (e.g. a vendor matching the PR's implementer). */
  readonly vendor?: string
  /** Fixed text, or a function of the review input, for the review comment
   *  body. Defaults to an `approve as-is` verdict comment shaped like a
   *  real reviewer's output. */
  readonly text?: string | ((input: ReviewInput) => string)
}

/** A `Reviewer` for tests: never shells out, returns a configurable
 *  verbatim review comment. Used by orchestrator gate tests and by
 *  consumers implementing their own `Reviewer` against this interface. */
export function createFakeReviewer(config: FakeReviewerConfig = {}): Reviewer {
  const vendor = config.vendor ?? 'fake'

  return {
    vendor,
    async review(input) {
      const text =
        typeof config.text === 'function'
          ? config.text(input)
          : (config.text ?? `## Reviewer agent (${vendor})\n\nLooks good.\n\nVerdict: approve as-is`)

      return { text }
    },
  }
}
