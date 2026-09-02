import { MalformedReviewError } from './errors'

// Matches "## Reviewer agent (Codex)" and its round-N variant,
// "## Reviewer agent (Codex), round 2". Codex's raw output includes a progress log
// before the actual review; the header marks where the review begins.
const HEADER_RE = /^## Reviewer agent \(Codex\)(?:, round \d+)?[ \t]*$/m

const TAIL_LINES = 40

/**
 * Extracts the review text from Codex's raw stdout: everything from the first line
 * matching the "## Reviewer agent (Codex)" header (inclusive) to the end of the output.
 * Never `head` — the header can appear after an arbitrarily long progress log.
 *
 * Throws `MalformedReviewError` if the header is missing, carrying the last 40 lines of
 * raw output for diagnostics. The caller must never post a review without the header:
 * a missing header means we cannot trust that Codex actually reached a verdict.
 */
export function extractReview(rawOutput: string): string {
  const match = HEADER_RE.exec(rawOutput)

  if (!match) {
    throw new MalformedReviewError(
      'Codex output is missing the "## Reviewer agent (Codex)" header; refusing to return an unverifiable review.',
      lastLines(rawOutput, TAIL_LINES),
    )
  }

  return rawOutput.slice(match.index).replace(/\s+$/, '')
}

function lastLines(text: string, n: number): string {
  const lines = text.split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}
