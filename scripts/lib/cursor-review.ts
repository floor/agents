/** Prompt, verdict detection and retry for the Cursor committee bridge. */

import type { TaskAssignment } from '@floor-agents/gateway'

/** The review prompt a Cursor-hosted committee member receives. */
export function buildCursorReviewPrompt(task: Pick<TaskAssignment, 'title' | 'body' | 'systemPrompt'>): string {
  return [
    task.systemPrompt,
    '',
    `## Proposal: ${task.title}`,
    '',
    task.body,
    '',
    '---',
    'Review this proposal against the codebase in your working directory. You may read any file;',
    'you cannot modify anything, so do not try. End with the verdict line the proposal asks for.',
  ].join('\n')
}

/**
 * Whether a reply carries a verdict. The committee scripts ask for
 * `VOTE: APPROVE|REJECT`; the decision committee asks for `RECOMMEND: A|B`.
 */
export function hasVerdict(text: string): boolean {
  return /\b(VOTE|RECOMMEND)\s*:\s*\**\s*(APPROVE|REJECT|A|B)\b/i.test(text)
}

/**
 * Run a review, retrying once when the reply has no verdict.
 *
 * A headless turn can end having done nothing and still report success. A
 * reply without a verdict is treated as that failure: it is retried once, and a
 * second empty reply is returned as-is so the committee records an abstention
 * rather than a vote nobody cast.
 */
export async function reviewWithRetry(
  run: () => Promise<string>,
  log: (msg: string) => void = () => {},
  attempts = 2,
): Promise<string> {
  let last = ''
  for (let i = 1; i <= attempts; i++) {
    last = (await run()).trim()
    if (hasVerdict(last)) return last
    if (i < attempts) log(`reply ${i} carried no verdict — retrying`)
  }
  log(`no verdict after ${attempts} attempts — the committee will record an abstention`)
  return last
}
