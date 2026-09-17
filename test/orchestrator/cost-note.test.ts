import { test, expect, describe } from 'bun:test'
import { costNote, metaLine } from '../../packages/orchestrator/src/cost-note.ts'

describe('costNote', () => {
  test('writes a metered cost, and nothing at all for an unmetered run', () => {
    expect(costNote(1.2345)).toBe('$1.2345')
    expect(costNote(0.00005)).toBe('$0.0001')
    // A CLI on a subscription reports no price: "$0.0000" would claim the work was free.
    expect(costNote(0)).toBe('')
    expect(costNote(Number.NaN)).toBe('')
    expect(costNote(-1)).toBe('')
  })
})

describe('metaLine', () => {
  test('joins what is present, so an empty cost leaves no dangling separator', () => {
    expect(metaLine(['3m 2s', '$0.5000'])).toBe('3m 2s | $0.5000')
    expect(metaLine(['3m 2s', ''])).toBe('3m 2s')
    expect(metaLine(['', ''])).toBe('')
  })
})
