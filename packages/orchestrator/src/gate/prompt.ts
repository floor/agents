// Builds the review prompt handed to a Reviewer for a PR that needs
// review. Uses the PR diff (already available via GitAdapter.getPRDiff) to
// derive the changed-file list, rather than adding a dedicated GitAdapter
// method for it.

import { NO_CHECKLIST_TEXT } from './checklists.ts'

export type ReviewPromptContext = {
  readonly repo: string
  readonly prNumber: string
  readonly title: string
  readonly body: string
  readonly baseRef: string
  readonly headRef: string
  readonly headSha: string
  readonly changedFiles: readonly string[]
  /** Pre-rendered checklist text (see gate/checklists.ts), already
   *  resolved for this PR's labels/changed paths and fetched at the PR's
   *  base branch head sha (never the PR head, so a PR cannot edit the
   *  checklist that reviews it). Optional — a caller that never wires up checklists (or an
   *  older caller predating this field) simply gets the "no checklist
   *  matched" placeholder text rendered in its place, not a literal
   *  `{{checklists}}` left in the prompt. */
  readonly checklists?: string
  /** The merge-base commit sha of `baseRef` and `headSha` (see
   *  `GitAdapter.compare()`/`CompareResult.mergeBaseSha` in
   *  @floor-agents/core) — the correct diff base for "what does this PR
   *  actually change", since `baseRef`'s tip moves forward as other work
   *  merges while this PR sits open. Deliberately never `PRDetails.baseSha`
   *  — see that field's own doc comment. Optional — a caller that can't
   *  resolve it (gate/loop.ts logs when `GitAdapter.compare()` fails) gets
   *  `MERGE_BASE_UNRESOLVED_TEXT` rendered in its place instead of a
   *  literal `{{mergeBase}}` left in the prompt. */
  readonly mergeBase?: string
}

/** Rendered in place of `{{mergeBase}}` when the caller couldn't resolve a
 *  merge-base sha this pass (e.g. `GitAdapter.compare()` failed). Reads
 *  sensibly inline in the template's "git diff {{mergeBase}}...{{headSha}}"
 *  phrasing while making the degraded state visible to the reviewer rather
 *  than silently falling back to a wrong-but-plausible-looking sha. */
export const MERGE_BASE_UNRESOLVED_TEXT = '(unresolved this pass — treat the changed-files list above as authoritative for this PR\'s scope instead)'

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
 *  changedFiles (rendered as one "- path" line per file), checklists
 *  (rendered as-is — see gate/checklists.ts for how it's built; falls
 *  back to a "no checklist matched" line when `ctx.checklists` is unset,
 *  same shape as changedFiles' own fallback), mergeBase (the diff base —
 *  falls back to `MERGE_BASE_UNRESOLVED_TEXT` when `ctx.mergeBase` is
 *  unset, same shape as checklists' own fallback). An unknown placeholder
 *  is left untouched so a template typo is visible in the posted prompt
 *  rather than silently swallowed. */
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
    checklists: ctx.checklists ?? NO_CHECKLIST_TEXT,
    mergeBase: ctx.mergeBase ?? MERGE_BASE_UNRESOLVED_TEXT,
  }

  return template.replace(PLACEHOLDER_RE, (full, key) => (key in values ? values[key]! : full))
}
