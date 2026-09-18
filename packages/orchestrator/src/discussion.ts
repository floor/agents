/**
 * The issue's comments, as the implementer should read them.
 *
 * A retry after a stop used to see only title and body, so a coordinator's
 * hint sat in Linear unread. Progress comments — the run narrating itself —
 * are dropped; people's notes and the engine's own reports are kept.
 */

import type { IssueComment } from '@floor-agents/core'

const MAX_COMMENTS = 20
const MAX_CHARS = 16_000
/** A comment longer than this is shortened, never dropped: head and tail are where people put what matters. */
const MAX_COMMENT_CHARS = 4_000
const COMMENT_HEAD = 3_000
const COMMENT_TAIL = 1_000

/** Last line of a comment signed by an implementer, reviewer or committee member. */
const PROGRESS_SIGNATURE = /^\*\*Agent:\*\* .+ · (implementer|reviewer|committee member)$/

function isProgressComment(body: string): boolean {
  const last = body.trimEnd().split(/\r?\n/).pop() ?? ''
  return PROGRESS_SIGNATURE.test(last)
}

/**
 * One oversized comment used to empty the whole discussion: the block was
 * shrunk by dropping comments until it fit, and a 47,000-character hint never
 * fits. Three coordinator hints reached no run that way (FLO-163, FLO-165).
 */
function shorten(body: string): string {
  if (body.length <= MAX_COMMENT_CHARS) return body
  const omitted = body.length - COMMENT_HEAD - COMMENT_TAIL
  return `${body.slice(0, COMMENT_HEAD)}\n\n… (${omitted} characters omitted — the full comment is on the issue) …\n\n${body.slice(-COMMENT_TAIL)}`
}

function formatComment(comment: IssueComment): string {
  const date = comment.createdAt.toISOString().slice(0, 10)
  return `**${comment.author}** (${date}):\n${shorten(comment.body)}`
}

function render(entries: readonly IssueComment[], omitted: number): string {
  const parts = ['## Discussion', '']
  if (omitted > 0) parts.push(`(${omitted} earlier comments omitted)`, '')
  parts.push(entries.map(formatComment).join('\n\n'))
  return parts.join('\n')
}

/**
 * Comments worth reading, as a `## Discussion` block: oldest first, progress
 * comments dropped, the most recent 20, 16,000 characters at most.
 *
 * The newest comments have priority — a hint is the last thing said. Older
 * ones are dropped first and counted; a long one is shortened. The newest kept
 * comment is never dropped, so a discussion that exists never reads as empty.
 */
export function discussionSection(comments: IssueComment[]): string {
  const kept = [...comments]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .filter(c => !isProgressComment(c.body))
  if (kept.length === 0) return ''

  let omitted = Math.max(0, kept.length - MAX_COMMENTS)
  let chosen = kept.slice(-MAX_COMMENTS)
  let text = render(chosen, omitted)

  while (chosen.length > 1 && text.length > MAX_CHARS) {
    chosen = chosen.slice(1)
    omitted++
    text = render(chosen, omitted)
  }

  return text
}
