/**
 * A blocker that stood through a revision.
 *
 * The review loop assumes every blocker is the implementer's to resolve. Some are
 * not: on mtrl #92 Codex wrote the same blocker three cycles running — "keep the
 * 0.9.x behaviour, or move the change to the next major" — a question of policy
 * the implementer could not answer. Each repeat cost a revision turn, a gate and
 * a review, and the loop ended at its maximum with nothing a person could act on.
 *
 * When a member repeats a blocker it already wrote before the revision, the
 * implementer has had its try. The loop stops there and says which blocker.
 *
 * Reviews are prose, so "the same" is measured: the share of significant words
 * two blockers have in common. The three mtrl wordings score 0.64–0.75 against
 * each other; the successive, different blockers of vlist #260 score under 0.4.
 * A miss costs what the loop cost before; a false alarm asks a person one cycle
 * early, with the blocker in front of them.
 */

import type { ReviewRecord } from '@floor-agents/core'

export const STANDING_THRESHOLD = 0.6

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'not', 'are', 'but', 'its', 'their', 'than',
  'must', 'should', 'when', 'where', 'which', 'instead', 'still', 'also', 'has', 'have', 'been', 'being',
])

function significantWords(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[`*_]/g, '').split(/[^a-z0-9.]+/)
  const kept = new Set<string>()
  for (const raw of words) {
    const word = raw.replace(/^\.+|\.+$/g, '').replace(/(?<=[a-z]{3})s$/, '')
    if (word.length >= 3 && !STOP_WORDS.has(word)) kept.add(word)
  }
  return kept
}

/** Share of significant words in common (Jaccard), 0 to 1. */
export function similarity(a: string, b: string): number {
  const wa = significantWords(a)
  const wb = significantWords(b)
  if (!wa.size || !wb.size) return 0
  let common = 0
  for (const w of wa) if (wb.has(w)) common++
  return common / (wa.size + wb.size - common)
}

export type MemberBlockers = { readonly agentId: string; readonly agentName: string; readonly blockers: readonly string[] }

export type StandingBlocker = {
  readonly agentId: string
  readonly agentName: string
  readonly blocker: string
  /** What the same member wrote before the revision. */
  readonly earlier: string
}

/**
 * The blockers of this cycle that the same member had already written in the
 * previous one. Only a previous cycle that asked for changes on another commit
 * counts: a revision must have happened in between — or the loop must already
 * have stopped on a standing blocker and been reopened with `review --issue`.
 */
export function standingBlockers(
  previous: ReviewRecord | undefined,
  current: readonly MemberBlockers[],
  commitSha: string | null,
): StandingBlocker[] {
  if (!previous || previous.outcome !== 'request_changes') return []
  // The same commit judged twice is not a revision — unless the loop had stopped on
  // a standing blocker and was reopened: a member that repeats it once more, after a
  // person settled the point, is still not the implementer's to answer.
  if (previous.commitSha && previous.commitSha === commitSha && !previous.standing?.length) return []
  const standing: StandingBlocker[] = []
  for (const member of current) {
    const before = previous.votes.find(v => v.agentId === member.agentId)?.blockers ?? []
    for (const blocker of member.blockers) {
      const earlier = before.find(b => similarity(b, blocker) >= STANDING_THRESHOLD)
      if (earlier) standing.push({ agentId: member.agentId, agentName: member.agentName, blocker, earlier })
    }
  }
  return standing
}
