/**
 * Reading a vote out of a review.
 *
 * The parser used to return the first `VOTE:` it found. Codex's review of
 * floor/vlist#250 quoted a phrase — "a partial `VOTE: APPROVE` is insufficient
 * evidence" — and ended with **VOTE: REJECT**: it was recorded as an approval.
 * A vote is a reviewer's last word, so the last marker wins, and a marker
 * quoted as code is not a vote.
 */

export type Vote = 'approve' | 'reject' | 'abstain'

const MARKER = /VOTE\s*:\s*[*_`]*\s*(APPROVED?|REJECT(?:ED)?|REQUEST(?:ED)?[ _-]CHANGES|CHANGES[ _-]REQUESTED)\b/gi

/** Fenced blocks and inline code spans: what a reviewer quotes, not what it says. */
function withoutCode(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

/** Every marker outside code, in order. More than one distinct value means the review argued with itself. */
export function voteMarkers(response: string): Vote[] {
  const found: Vote[] = []
  for (const match of withoutCode(response).matchAll(MARKER)) {
    found.push(/^APPROV/i.test(match[1]!) ? 'approve' : 'reject')
  }
  return found
}

/** The reviewer's last word; `abstain` when it never said one. */
export function extractVote(response: string): Vote {
  return voteMarkers(response).at(-1) ?? 'abstain'
}
