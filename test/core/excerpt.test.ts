import { describe, expect, test } from 'bun:test'
import { createExcerptBuffer, excerpt } from '@floor-agents/core'

describe('excerpt', () => {
  test('a text that fits is returned whole, trimmed', () => {
    expect(excerpt('  short  ')).toBe('short')
  })

  test('the end of a long output survives — that is where the reason is', () => {
    // The shape of the Codex failure on vlist #259: a banner, the prompt, then one line that matters.
    const output = `OpenAI Codex v0.154.0\n${'prompt '.repeat(2_000)}\nERROR: You've hit your usage limit`
    const kept = excerpt(output, 500)
    expect(kept).toContain('OpenAI Codex')
    expect(kept.endsWith("ERROR: You've hit your usage limit")).toBe(true)
    expect(kept).toMatch(/\[… \d+ characters omitted …\]/)
    expect(kept.length).toBeLessThan(560)
  })

  test('the omitted count is exact', () => {
    const kept = excerpt('a'.repeat(1_000), 100)
    expect(kept).toContain('[… 900 characters omitted …]')
  })
})

describe('createExcerptBuffer', () => {
  test('a stream that fits is kept whole, however it was chunked', () => {
    const kept = createExcerptBuffer(4, 8)
    for (const chunk of ['ab', 'cdef', 'ghi']) kept.push(chunk)
    expect(kept.text()).toBe('abcdefghi')
  })

  test('a long stream keeps its head and its last characters, and says how much is gone', () => {
    const kept = createExcerptBuffer(4, 8)
    kept.push('HEAD')
    for (let i = 0; i < 1_000; i++) kept.push('0123456789')
    kept.push('THE END.')
    expect(kept.text()).toBe('HEAD\n[… 10000 characters omitted …]\nTHE END.')
  })

  test('memory stays bounded: the window slides', () => {
    const kept = createExcerptBuffer(10, 100)
    for (let i = 0; i < 10_000; i++) kept.push('x'.repeat(50))
    expect(kept.text().length).toBeLessThan(200)
  })
})
