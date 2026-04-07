import { test, expect } from 'bun:test'
import { estimateCost } from '@floor-agents/openai'

test('calculates cost for known OpenAI models', () => {
  // gpt-4o: $2.5/M input, $10/M output
  const cost = estimateCost('gpt-4o', 1000, 500, false)
  expect(cost).toBeCloseTo(0.0025 + 0.005, 6)
})

test('calculates cost for gpt-4o-mini', () => {
  // gpt-4o-mini: $0.15/M input, $0.6/M output
  const cost = estimateCost('gpt-4o-mini', 1000, 500, false)
  expect(cost).toBeCloseTo(0.00015 + 0.0003, 6)
})

test('returns zero cost for local models', () => {
  const cost = estimateCost('llama-3.2-8b', 10000, 5000, true)
  expect(cost).toBe(0)
})

test('uses default pricing for unknown remote models', () => {
  const cost = estimateCost('some-new-model', 1000, 500, false)
  // Default same as gpt-4o
  expect(cost).toBeCloseTo(0.0025 + 0.005, 6)
})
