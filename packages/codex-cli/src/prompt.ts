export type ReviewPromptVars = {
  readonly repo: string
  /**
   * The same PR number a caller typically also passes as `ReviewInput.prNumber`
   * (a `string` in `@floor-agents/core`'s `Reviewer` interface) — accepted as either
   * `string` or `number` here since this helper only ever renders it as text.
   */
  readonly prNumber: string | number
  readonly headSha: string
  readonly title: string
  readonly body: string
  readonly baseRef: string
  readonly changedFiles: readonly string[]
  readonly focus?: string
}

/**
 * Fills in the review prompt template (see `prompts/review.md`) with the given
 * variables. Placeholders are plain `{{name}}` tokens, replaced literally (no template
 * engine, no code execution) so the result is safe to hand straight to `review()`.
 */
export function renderReviewPrompt(template: string, vars: ReviewPromptVars): string {
  const changedFilesBlock = vars.changedFiles.length
    ? vars.changedFiles.map((file) => `- ${file}`).join('\n')
    : '(no changed files listed)'

  const focusBlock = vars.focus ? `\n## Focus\n\n${vars.focus}\n` : ''

  return template
    .replaceAll('{{repo}}', vars.repo)
    .replaceAll('{{prNumber}}', String(vars.prNumber))
    .replaceAll('{{headSha}}', vars.headSha)
    .replaceAll('{{title}}', vars.title)
    .replaceAll('{{body}}', vars.body)
    .replaceAll('{{baseRef}}', vars.baseRef)
    .replaceAll('{{changedFiles}}', changedFilesBlock)
    .replaceAll('{{focusBlock}}', focusBlock)
}
