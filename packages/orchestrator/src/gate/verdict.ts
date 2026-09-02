// Parses a PR comment into a reviewer verdict, per this mode's
// independent-review protocol (see docs/review-gate.md):
//
//   ## Reviewer agent (Codex)
//   ...review body...
//   Verdict: approve as-is
//
// A comment only counts as a verdict if it STARTS WITH the header line
// (a reviewer posts its findings verbatim as a PR comment starting with
// `## Reviewer agent (<Vendor>)`) and contains at least one exact verdict
// line. Everything else — a comment quoting/reproducing an older verdict
// inline, chatter, questions — is not a verdict.
//
// This module only parses TEXT. The vendor name in the header is
// whatever the comment claims, not a verified identity — anyone who can
// comment on the PR can write it. Identity (is this comment actually from
// a trusted reviewer?) is enforced separately, by comment AUTHOR, in
// decision.ts's `trustedReviewers` — never trust `ParsedVerdict.vendor`
// on its own for a gating decision.

export type Decision = 'approve as-is' | 'approve with nits' | 'changes needed'

export type ParsedVerdict = {
  readonly vendor: string
  readonly round: number | null
  readonly decision: Decision
  /** Every 12-40 hex-char sha-looking token mentioned anywhere in the
   *  comment as a deliberate "I reviewed this commit" statement, lowercased,
   *  de-duplicated, in first-seen order. A shorter (7-11 char) token is
   *  excluded — too short to rule out an unrelated commit sharing the same
   *  prefix once a repo has more than a few thousand commits — and a token
   *  immediately adjacent to a `/` is excluded as a URL or file-path
   *  segment (e.g. a permalink's `/commit/<sha>/...` or a build path like
   *  `/build/<sha>`), not a reviewer naming the commit they reviewed. */
  readonly shas: readonly string[]
}

// Exactly "## Reviewer agent (" — a missing space (e.g. "##Reviewer agent")
// does not match the documented header format and is not a verdict.
const HEADER_RE = /^## Reviewer agent \(([^,)]+?)(?:,\s*round\s*(\d+))?\)\s*$/
// 12-40 hex chars: long enough that a prefix collision with an unrelated
// commit is not a realistic risk (git itself treats 12 chars as safely
// unambiguous for most repos), short enough to allow an abbreviated sha.
const SHA_RE = /\b[0-9a-fA-F]{12,40}\b/g

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
  for (const match of body.matchAll(SHA_RE)) {
    const token = match[0]
    const start = match.index
    const end = start + token.length
    // A token immediately touching a "/" is a URL or file-path segment,
    // not a reviewer naming the commit — exclude it (see ParsedVerdict.shas).
    if (body[start - 1] === '/' || body[end] === '/') continue

    const sha = token.toLowerCase()
    if (!seen.has(sha)) {
      seen.add(sha)
      shas.push(sha)
    }
  }

  return { vendor, round, decision, shas }
}
