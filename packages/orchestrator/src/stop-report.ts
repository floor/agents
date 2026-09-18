/**
 * What the issue is told when a run stops before its PR.
 *
 * A killed turn used to reach the issue as "❌ Agent error" over the raw
 * message, signed as if the agent had written it, and said nothing about the
 * twelve lines it had managed — a reader had to open the machine's log to learn
 * that a time budget, not a crash, had ended the run (FLO-163, 2026-09-18). The
 * report names the budget that ran out, shows the diff the worktree holds, and
 * says how to run again.
 */

/** A turn that ended without a result: which budget ran out, and what was on disk. */
export class AgentStopped extends Error {
  constructor(message: string, readonly written: string) {
    super(message)
    this.name = 'AgentStopped'
  }
}

/** The uncommitted work in a worktree, as `git diff --stat` plus the new files. */
export function writtenSummary(diffStat: string, untracked: string): string {
  const files = untracked.split('\n').map(l => l.trim()).filter(Boolean).map(f => ` new: ${f}`)
  return [diffStat.trimEnd(), ...files].filter(Boolean).join('\n')
}

export function stopReport(agentName: string, reason: string, written: string, issueKey: string): string {
  return [
    `⏱ **${agentName}** stopped: ${reason}`,
    '',
    written ? 'Written before the stop, uncommitted:' : 'Nothing was written before the stop.',
    ...(written ? ['```', written, '```'] : []),
    '',
    `The next run starts again from the base branch. Labeled \`needs-human\` until it is retried: \`floor-agents run --issue ${issueKey} --retry\`.`,
  ].join('\n')
}

export function crashReport(message: string, issueKey: string): string {
  return [
    '❌ **Run failed**',
    '',
    '```',
    message,
    '```',
    '',
    `Labeled \`needs-human\` until it is retried: \`floor-agents run --issue ${issueKey} --retry\`.`,
  ].join('\n')
}
