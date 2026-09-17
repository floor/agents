/** Prompt + CLI argument construction for the Grok review bridge. */

export type GrokTask = {
  readonly title: string
  readonly body: string
  readonly systemPrompt: string
}

/** Build the full review prompt fed to `grok` via --prompt-file. */
export function buildGrokPrompt(task: GrokTask): string {
  return [
    task.systemPrompt,
    '',
    `## Proposal: ${task.title}`,
    '',
    task.body,
    '',
    '---',
    'Review this proposal against the codebase in your working directory.',
    // Tool-use guidance: grok-build's read_file aborts the whole turn if a file
    // exceeds its output cap (e.g. create.ts ~41KB). Locate code with grep and read
    // in ranges so a single read never blows the limit and kills the review.
    'When inspecting code, locate it with `grep`/`list_dir`, then `read_file` in line',
    'ranges (offset/limit, ≤400 lines). Do NOT read an entire large file in one call.',
    'Provide your technical analysis, then end with exactly **VOTE: APPROVE** or **VOTE: REJECT**.',
  ].join('\n')
}

/**
 * Build the `grok` argv for a single-turn, read-only, non-interactive review that
 * reads its prompt from `promptFile` and prints the response to stdout.
 */
export function buildGrokArgs(opts: {
  promptFile: string
  cwd: string
  model?: string
  effort?: string
  sandbox?: string
  boundedReadOnly?: boolean
}): string[] {
  const args = [
    '--prompt-file', opts.promptFile,
    '--cwd', opts.cwd,
    '--output-format', 'plain',
    // Non-interactive: never block on a tool-approval prompt in headless mode.
    '--permission-mode', 'dontAsk',
  ]
  // Filesystem read-only guard (mirrors codex `--sandbox read-only`). Profile name
  // is configurable via GROK_SANDBOX; default to read-only for review safety.
  args.push('--sandbox', opts.sandbox ?? 'read-only')
  // Fallback path: allowlist ONLY bounded-output read tools. read_file is omitted
  // (it aborts the turn on a too-large file), and we use an allowlist rather than
  // denylisting read_file — dropping read_file alone leaves search_replace with an
  // unsatisfied Read-tool requirement and the agent fails to build.
  if (opts.boundedReadOnly) args.push('--tools', 'grep,list_dir')
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  return args
}
