/** Tool logic for the file-backed Antigravity MCP server. */
import type { CommitteeFiles, PendingTask } from './committee-files.ts'

/** Render a pending review as the text returned by get_pending_review. */
export function formatPending(task: PendingTask): string {
  return [
    `taskId: ${task.id}`,
    `title: ${task.title}`,
    '',
    '## Reviewer instructions',
    task.systemPrompt,
    '',
    '## Proposal',
    task.body,
    '',
    'When done, call submit_vote with this taskId and your full review ending in **VOTE: APPROVE** or **VOTE: REJECT**.',
  ].join('\n')
}

/** get_pending_review: the next pending RFC, or a "none" message. */
export function getPendingReviewText(files: CommitteeFiles): string {
  const task = files.oldestPending()
  return task ? formatPending(task) : 'No review pending.'
}

/** submit_vote: record a vote for the relay to forward. */
export function submitVote(files: CommitteeFiles, taskId: string, content: string): void {
  files.writeResult(taskId, content)
}
