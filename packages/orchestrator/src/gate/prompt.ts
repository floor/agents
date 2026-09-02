// Builds the review prompt handed to a Reviewer for a PR that needs
// review. Uses the PR diff (already available via GitAdapter.getPRDiff) to
// derive the changed-file list, rather than adding a dedicated GitAdapter
// method for it.

export type ReviewPromptContext = {
  readonly repo: string
  readonly prNumber: string
  readonly title: string
  readonly body: string
  readonly baseRef: string
  readonly headRef: string
  readonly headSha: string
  readonly changedFiles: readonly string[]
}

const DIFF_FILE_RE = /^diff --git a\/(.+) b\/(.+)$/gm

/** Extracts the changed file paths (post-change side) from a unified git
 *  diff, in first-seen order, deduplicated. Returns [] for an empty or
 *  unparseable diff rather than throwing — a prompt with no file list is
 *  still useful. */
export function extractChangedFiles(diffText: string): string[] {
  const seen = new Set<string>()
  const files: string[] = []

  for (const match of diffText.matchAll(DIFF_FILE_RE)) {
    const path = match[2]!
    if (!seen.has(path)) {
      seen.add(path)
      files.push(path)
    }
  }

  return files
}

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g

/** Fills a `{{placeholder}}` template with the review context. Supported
 *  placeholders: repo, prNumber, title, body, baseRef, headRef, headSha,
 *  changedFiles (rendered as one "- path" line per file). An unknown
 *  placeholder is left untouched so a template typo is visible in the
 *  posted prompt rather than silently swallowed. */
export function buildReviewPrompt(template: string, ctx: ReviewPromptContext): string {
  const values: Record<string, string> = {
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    title: ctx.title,
    body: ctx.body,
    baseRef: ctx.baseRef,
    headRef: ctx.headRef,
    headSha: ctx.headSha,
    changedFiles: ctx.changedFiles.length > 0
      ? ctx.changedFiles.map(f => `- ${f}`).join('\n')
      : '(no changed files found in the diff)',
  }

  return template.replace(PLACEHOLDER_RE, (full, key) => (key in values ? values[key]! : full))
}
