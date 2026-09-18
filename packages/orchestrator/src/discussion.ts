/**
 * The issue's comments, as the implementer should read them.
 *
 * A retry after a stop used to see only title and body, so a coordinator's
 * hint sat in Linear unread. Progress comments — the run narrating itself —
 * are dropped; people's notes and the engine's own reports are kept.
 */

import type { IssueComment } from '@floor-agents/core'

const MAX_COMMENTS = 20
const MAX_CHARS = 8_000

/** Last line of a comment signed by an implementer, reviewer or committee member. */
const PROGRESS_SIGNATURE = /^\*\*Agent:\*\* .+ · (implementer|reviewer|committee member)$/

function isProgressComment(body: string): boolean {
  const last = body.trimEnd().split(/\r?\n/).pop() ?? ''
  return PROGRESS_SIGNATURE.test(last)
}

function formatComment(comment: IssueComment): string {
  const date = comment.createdAt.toISOString().slice(0, 10)
  return `**${comment.author}** (${date}):\n${comment.body}`
}

function render(entries: readonly IssueComment[], omitted: number): string {
  const parts = ['## Discussion', '']
  if (omitted > 0) parts.push(`(${omitted} earlier comments omitted)`, '')
  parts.push(entries.map(formatComment).join('\n\n'))
  return parts.join('\n')
}

/**
 * Comments worth reading, as a `## Discussion` block: oldest first, progress
 * comments dropped, capped at the most recent 20 and 8,000 characters.
 *
 * An empty result adds nothing to the prompt.
 */
export function discussionSection(comments: IssueComment[]): string {
  const kept = [...comments]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .filter(c => !isProgressComment(c.body))
  if (kept.length === 0) return ''

  let omitted = Math.max(0, kept.length - MAX_COMMENTS)
  let chosen = kept.slice(-MAX_COMMENTS)
  let text = render(chosen, omitted)

  while (chosen.length > 0 && text.length > MAX_CHARS) {
    chosen = chosen.slice(1)
    omitted++
    if (chosen.length === 0) return ''
    text = render(chosen, omitted)
  }

  return text
}
