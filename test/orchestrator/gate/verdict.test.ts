import { test, expect } from 'bun:test'
import { parseVerdictComment } from '../../../packages/orchestrator/src/gate/verdict.ts'

test('parses a basic approve-as-is verdict', () => {
  const body = [
    '## Reviewer agent (Codex)',
    '',
    'Looks correct.',
    '',
    'Verdict: approve as-is',
  ].join('\n')

  expect(parseVerdictComment(body)).toEqual({
    vendor: 'Codex',
    round: null,
    decision: 'approve as-is',
    shas: [],
  })
})

test('parses vendor and round from the header', () => {
  const body = [
    '## Reviewer agent (Codex, round 2)',
    '',
    'Verdict: changes needed',
  ].join('\n')

  const parsed = parseVerdictComment(body)
  expect(parsed?.vendor).toBe('Codex')
  expect(parsed?.round).toBe(2)
  expect(parsed?.decision).toBe('changes needed')
})

test('parses approve with nits', () => {
  const body = ['## Reviewer agent (Gemini)', 'Verdict: approve with nits'].join('\n')
  expect(parseVerdictComment(body)?.decision).toBe('approve with nits')
})

test('returns null when there is no header at all', () => {
  const body = 'Just a regular comment.\n\nVerdict: approve as-is'
  expect(parseVerdictComment(body)).toBeNull()
})

test('returns null when the header is not the first line', () => {
  const body = [
    'Some preamble first.',
    '## Reviewer agent (Codex)',
    'Verdict: approve as-is',
  ].join('\n')
  expect(parseVerdictComment(body)).toBeNull()
})

test('leading blank lines before the header are tolerated', () => {
  const body = ['', '  ', '## Reviewer agent (Codex)', 'Verdict: approve as-is'].join('\n')
  expect(parseVerdictComment(body)?.vendor).toBe('Codex')
})

test('a header missing the space after "##" does not count', () => {
  const body = ['##Reviewer agent (Codex)', 'Verdict: approve as-is'].join('\n')
  expect(parseVerdictComment(body)).toBeNull()
})

test('a header with extra spaces before "Reviewer" does not count', () => {
  const body = ['##  Reviewer agent (Codex)', 'Verdict: approve as-is'].join('\n')
  expect(parseVerdictComment(body)).toBeNull()
})

test('returns null when the header is present but there is no verdict line', () => {
  const body = ['## Reviewer agent (Codex)', 'Still reviewing, no verdict yet.'].join('\n')
  expect(parseVerdictComment(body)).toBeNull()
})

test('a near-miss verdict line (wrong case, wrong wording) does not count', () => {
  const body = [
    '## Reviewer agent (Codex)',
    'verdict: approve as-is',
    'Verdict: Approved',
    'Verdict: approve as is',
  ].join('\n')
  expect(parseVerdictComment(body)).toBeNull()
})

test('only the LAST matching verdict line counts, even if an earlier one is quoted', () => {
  const body = [
    '## Reviewer agent (Codex, round 3)',
    '',
    'Previous round said:',
    '```',
    '## Reviewer agent (Codex, round 2)',
    'Verdict: changes needed',
    '```',
    '',
    'That is now fixed.',
    '',
    'Verdict: approve as-is',
  ].join('\n')

  const parsed = parseVerdictComment(body)
  expect(parsed?.decision).toBe('approve as-is')
  expect(parsed?.round).toBe(3)
})

test('extracts every distinct sha mentioned, deduplicated, lowercased', () => {
  const body = [
    '## Reviewer agent (Codex)',
    'Reviewed commit ABC123456789 (also known as abc123456789).',
    'Compared against deadbeef00112233445566778899aabbccddeeff.',
    'Verdict: approve as-is',
  ].join('\n')

  expect(parseVerdictComment(body)?.shas).toEqual([
    'abc123456789',
    'deadbeef00112233445566778899aabbccddeeff',
  ])
})

test('a sha shorter than 12 hex chars is not extracted', () => {
  const body = [
    '## Reviewer agent (Codex)',
    'Reviewed at abc1234.',
    'Verdict: approve as-is',
  ].join('\n')

  expect(parseVerdictComment(body)?.shas).toEqual([])
})

test('a hex token embedded in a URL path segment is not extracted as a sha', () => {
  const body = [
    '## Reviewer agent (Codex)',
    'See the build at https://ci.example.com/build/deadbeef00112233445566778899aabbccddeeff/logs for details.',
    'Verdict: approve as-is',
  ].join('\n')

  expect(parseVerdictComment(body)?.shas).toEqual([])
})

test('a 12+ char hex token immediately preceded by "/" is not extracted (left adjacency)', () => {
  // Long enough to pass the length rule on its own — this isolates the
  // slash-adjacency exclusion specifically, rather than the length floor.
  const body = [
    '## Reviewer agent (Codex)',
    'CI status: /build/deadbeef00112233445566778899aabbccddeeff passed.',
    'Verdict: approve as-is',
  ].join('\n')

  expect(parseVerdictComment(body)?.shas).toEqual([])
})

test('a 12+ char hex token immediately followed by "/" is not extracted (right adjacency)', () => {
  const body = [
    '## Reviewer agent (Codex)',
    'See https://ci.example.com/deadbeef00112233445566778899aabbccddeeff/logs for details.',
    'Verdict: approve as-is',
  ].join('\n')

  expect(parseVerdictComment(body)?.shas).toEqual([])
})

test('a hex token embedded in a shorter URL path segment (7 hex chars) is excluded by length alone', () => {
  const body = [
    '## Reviewer agent (Codex)',
    'CI status: /build/454cd4c passed.',
    'Verdict: approve as-is',
  ].join('\n')

  expect(parseVerdictComment(body)?.shas).toEqual([])
})

test('a 41-char hex token is not extracted (exceeds the 40-char sha length)', () => {
  const body = [
    '## Reviewer agent (Codex)',
    'Reviewed at deadbeef00112233445566778899aabbccddeeff0.',
    'Verdict: approve as-is',
  ].join('\n')

  expect(parseVerdictComment(body)?.shas).toEqual([])
})

test('a sha mentioned in plain prose (not URL-adjacent) is still extracted', () => {
  const body = [
    '## Reviewer agent (Codex)',
    'Reviewed at deadbeef00112233445566778899aabbccddeeff, looks good.',
    'Verdict: approve as-is',
  ].join('\n')

  expect(parseVerdictComment(body)?.shas).toEqual(['deadbeef00112233445566778899aabbccddeeff'])
})

test('returns null on an empty body', () => {
  expect(parseVerdictComment('')).toBeNull()
})

test('returns null on a body of only whitespace', () => {
  expect(parseVerdictComment('   \n  \n')).toBeNull()
})
