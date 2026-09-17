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

/**
 * Build the `codex exec` argv for a review writing its last message to `outFile`.
 *
 * `sandbox` is Codex's own sandbox. Measured on macOS, it cannot run inside ours:
 * Codex applies its sandbox with sandbox-exec for each shell command, a sandboxed
 * process may not apply another, and every command then fails with
 * "sandbox_apply: Operation not permitted". So a bridge that runs Codex in our
 * reviewer sandbox turns Codex's off, and ours does the containing.
 */
export function buildCodexArgs(opts: {
  cwd: string
  outFile: string
  model?: string
  sandbox?: 'read-only' | 'danger-full-access'
}): string[] {
  const args = [
    'exec',
    '--sandbox', opts.sandbox ?? 'read-only',
    '--cd', opts.cwd,
    '--skip-git-repo-check',
    '--output-last-message', opts.outFile,
  ]
  if (opts.model) args.push('--model', opts.model)
  args.push('-') // read prompt from stdin
  return args
}
