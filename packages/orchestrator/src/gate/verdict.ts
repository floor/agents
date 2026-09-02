// Parses a PR comment into a reviewer verdict, per the review-and-gate
// protocol (floor/radiooooo's AGENTS.md, "Review" section):
//
//   ## Reviewer agent (Codex)
//   ...review body...
//   Verdict: approve as-is
//
// A comment only counts as a verdict if it STARTS WITH the header line
// (protocol: "post review.md's contents verbatim ... as a PR comment
// starting with `## Reviewer agent (Codex)`") and contains at least one
// exact verdict line. Everything else — a comment quoting/reproducing an
// older verdict inline, chatter, questions — is not a verdict.

export type Decision = 'approve as-is' | 'approve with nits' | 'changes needed'

export type ParsedVerdict = {
  readonly vendor: string
  readonly round: number | null
  readonly decision: Decision
  /** Every 7-40 hex-char sha-looking token mentioned anywhere in the
   *  comment, lowercased, de-duplicated, in first-seen order. */
  readonly shas: readonly string[]
}

const HEADER_RE = /^##\s*Reviewer agent \(([^,)]+?)(?:,\s*round\s*(\d+))?\)\s*$/
const SHA_RE = /\b[0-9a-fA-F]{7,40}\b/g

const VERDICT_LINES: Record<string, Decision> = {
  'Verdict: approve as-is': 'approve as-is',
  'Verdict: approve with nits': 'approve with nits',
  'Verdict: changes needed': 'changes needed',
}

/** Returns null when `body` is not a verdict comment: no header as the
 *  first (non-blank) line, or no exact verdict line anywhere in it. */
export function parseVerdictComment(body: string): ParsedVerdict | null {
  const lines = body.split(/\r?\n/)

  let i = 0
  while (i < lines.length && lines[i]!.trim() === '') i++
  if (i >= lines.length) return null

  const headerMatch = HEADER_RE.exec(lines[i]!.trim())
  if (!headerMatch) return null

  const vendor = headerMatch[1]!.trim()
  const round = headerMatch[2] ? Number(headerMatch[2]) : null

  // The LAST matching verdict line wins — a comment that quotes an earlier
  // verdict (e.g. in a code block) followed by a fresh one at the end must
  // resolve to the fresh one.
  let decision: Decision | null = null
  for (const line of lines) {
    const match = VERDICT_LINES[line.trim()]
    if (match) decision = match
  }
  if (!decision) return null

  const seen = new Set<string>()
  const shas: string[] = []
  for (const match of body.match(SHA_RE) ?? []) {
    const sha = match.toLowerCase()
    if (!seen.has(sha)) {
      seen.add(sha)
      shas.push(sha)
    }
  }

  return { vendor, round, decision, shas }
}
