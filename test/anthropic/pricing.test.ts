import { test, expect } from 'bun:test'
import { estimateCost } from '@floor-agents/anthropic'

test('calculates cost for known models', () => {
  // Sonnet: $3/M input, $15/M output
  const cost = estimateCost('claude-sonnet-4-20250514', 1000, 500)
  expect(cost).toBeCloseTo(0.003 + 0.0075, 6)
})

test('calculates cost for opus', () => {
  // Opus: $15/M input, $75/M output
  const cost = estimateCost('claude-opus-4-0-20250115', 1000, 500)
  expect(cost).toBeCloseTo(0.015 + 0.0375, 6)
})

test('uses default pricing for unknown models', () => {
  const cost = estimateCost('unknown-model', 1000, 500)
  // Default same as Sonnet
  expect(cost).toBeCloseTo(0.003 + 0.0075, 6)
})
