/**
 * Mirror a task adapter's comments to a team channel.
 *
 * The issue is the record: every turn of a run is already posted there, so the
 * channel needs no second vocabulary — it repeats what the issue says, as it is
 * said. That keeps one wording to maintain, and a channel that goes quiet means
 * the run stopped, not that a message type was forgotten.
 *
 * A failed post never fails the run. The record is the issue; the channel is a
 * window on it, and a revoked token or a blocked chat must not lose work.
 */

import type { TaskAdapter } from '@floor-agents/core'
import type { TeamChannel } from './team-channel.ts'

/** Markdown the issue carries but a channel message does not need. */
export function channelText(text: string): string {
  return text
    .replace(/^> /gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`{3}[a-z]*\n?/g, '')
    .replace(/`/g, '')
    .trim()
}

export function mirrorComments(
  adapter: TaskAdapter,
  channel: TeamChannel,
  opts: { readonly from?: string; readonly log?: (msg: string) => void } = {},
): TaskAdapter {
  const from = opts.from ?? 'Floor Agents'
  const log = opts.log ?? (() => {})
  return {
    ...adapter,
    watchIssues: adapter.watchIssues.bind(adapter),
    async addComment(issueId: string, text: string): Promise<void> {
      await adapter.addComment(issueId, text)
      try {
        await channel.post(from, `#${issueId} · ${channelText(text)}`)
      } catch (err) {
        log(`channel post failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}
