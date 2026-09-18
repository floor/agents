/**
 * How an implementer's pull request is reviewed before a person sees it.
 *
 * Merging stays with the coordinator. This only decides whether the engine
 * asks the committee (or a single `review_pr` agent) to look at the diff.
 */
export type ReviewConfig = {
  /**
   * When true, every agent with `vote` reviews the PR diff.
   * Default: true when the manifest seats no `review_pr` agent; false when it seats one.
   */
  readonly committee?: boolean
}
