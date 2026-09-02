import { test, expect } from 'bun:test'
import { extractReview } from '@floor-agents/antigravity-cli'
import { MalformedReviewError } from '@floor-agents/antigravity-cli'

test('extracts from the header to the end, dropping the progress log', () => {
  const raw = [
    'Reading files...',
    'Thinking...',
    '## Reviewer agent (Gemini)',
    '',
    'Looks fine.',
    'Verdict: approve as-is',
  ].join('\n')

  expect(extractReview(raw)).toBe(['## Reviewer agent (Gemini)', '', 'Looks fine.', 'Verdict: approve as-is'].join('\n'))
})

test('accepts the round-N header variant', () => {
  const raw = ['progress', '## Reviewer agent (Gemini), round 3', 'Verdict: changes needed'].join('\n')

  expect(extractReview(raw)).toBe(['## Reviewer agent (Gemini), round 3', 'Verdict: changes needed'].join('\n'))
})

test('finds the header even after a long progress log (never a head-based cut)', () => {
  const progress = Array.from({ length: 500 }, (_, i) => `progress line ${i}`).join('\n')
  const raw = `${progress}\n## Reviewer agent (Gemini)\nVerdict: approve with nits`

  expect(extractReview(raw)).toBe('## Reviewer agent (Gemini)\nVerdict: approve with nits')
})

test('throws MalformedReviewError when the header is missing', () => {
  const raw = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')

  expect(() => extractReview(raw)).toThrow(MalformedReviewError)
})

test('MalformedReviewError carries the last 40 lines of raw output', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`)
  const raw = lines.join('\n')

  try {
    extractReview(raw)
    expect.unreachable()
  } catch (err) {
    expect(err).toBeInstanceOf(MalformedReviewError)
    const tail = (err as InstanceType<typeof MalformedReviewError>).rawOutputTail
    expect(tail.split('\n')).toHaveLength(40)
    expect(tail.split('\n')[0]).toBe('line 20')
    expect(tail.split('\n').at(-1)).toBe('line 59')
  }
})

test('does not match a header mentioned mid-sentence without being at line start', () => {
  const raw = 'the text ## Reviewer agent (Gemini) is just an example, no real header here'

  expect(() => extractReview(raw)).toThrow(MalformedReviewError)
})

test('a Codex-style header does not match — this package only accepts its own vendor header', () => {
  const raw = ['progress', '## Reviewer agent (Codex)', 'Verdict: approve as-is'].join('\n')

  expect(() => extractReview(raw)).toThrow(MalformedReviewError)
})
