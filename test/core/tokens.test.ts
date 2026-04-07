import { test, expect } from 'bun:test'
import { estimateTokens } from '@floor-agents/core'

test('estimates tokens from text length', () => {
  expect(estimateTokens('')).toBe(0)
  expect(estimateTokens('a')).toBe(1)
  expect(estimateTokens('abcd')).toBe(1)
  expect(estimateTokens('abcde')).toBe(2)
  expect(estimateTokens('a'.repeat(100))).toBe(25)
})
