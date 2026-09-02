import { MalformedReviewError } from './errors'

// Matches "## Reviewer agent (Gemini)" and its round-N variant,
// "## Reviewer agent (Gemini), round 2". Antigravity's raw output includes
// progress/tool-use text before the actual review; the header marks where
// the review begins.
const HEADER_RE = /^## Reviewer agent \(Gemini\)(?:, round \d+)?[ \t]*$/m

const TAIL_LINES = 40

/**
 * Extracts the review text from Antigravity's raw stdout: everything from
 * the first line matching the "## Reviewer agent (Gemini)" header
 * (inclusive) to the end of the output. Never `head` — the header can
 * appear after an arbitrarily long progress log.
 *
 * Throws `MalformedReviewError` if the header is missing, carrying the last
 * 40 lines of raw output for diagnostics. The caller must never post a
 * review without the header: a missing header means we cannot trust that
 * Antigravity actually reached a verdict.
 */
export function extractReview(rawOutput: string): string {
  const match = HEADER_RE.exec(rawOutput)

  if (!match) {
    throw new MalformedReviewError(
      'Antigravity output is missing the "## Reviewer agent (Gemini)" header; refusing to return an unverifiable review.',
      lastLines(rawOutput, TAIL_LINES),
    )
  }

  return rawOutput.slice(match.index).replace(/\s+$/, '')
}

function lastLines(text: string, n: number): string {
  const lines = text.split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}
