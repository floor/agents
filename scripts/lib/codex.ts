/** Prompt + CLI argument construction for the Codex review bridge. */

export type CodexTask = {
  readonly title: string
  readonly body: string
  readonly systemPrompt: string
}

/** Build the full review prompt fed to `codex exec` on stdin. */
export function buildCodexPrompt(task: CodexTask): string {
  return [
    task.systemPrompt,
    '',
    `## Proposal: ${task.title}`,
    '',
    task.body,
    '',
    '---',
    'Review this proposal against the codebase in your working directory.',
    'Provide your technical analysis, then end with exactly **VOTE: APPROVE** or **VOTE: REJECT**.',
  ].join('\n')
}

/** Build the `codex exec` argv for a read-only review writing its last message to `outFile`. */
export function buildCodexArgs(opts: { cwd: string; outFile: string; model?: string }): string[] {
  const args = [
    'exec',
    '--sandbox', 'read-only',
    '--cd', opts.cwd,
    '--skip-git-repo-check',
    '--output-last-message', opts.outFile,
  ]
  if (opts.model) args.push('--model', opts.model)
  args.push('-') // read prompt from stdin
  return args
}
