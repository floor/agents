import { test, expect } from 'bun:test'
import { retry } from '@floor-agents/core'

test('returns result on first success', async () => {
  const result = await retry(async () => 'ok')
  expect(result).toBe('ok')
})

test('retries and succeeds after transient failures', async () => {
  let calls = 0
  const result = await retry(async () => {
    calls++
    if (calls < 3) throw new Error('transient')
    return 'ok'
  }, { delayMs: 10 })

  expect(result).toBe('ok')
  expect(calls).toBe(3)
})

test('throws last error after all retries exhausted', async () => {
  let calls = 0
  await expect(
    retry(async () => {
      calls++
      throw new Error('permanent')
    }, { maxRetries: 2, delayMs: 10 }),
  ).rejects.toThrow('permanent')

  expect(calls).toBe(3) // initial + 2 retries
})

test('respects custom options', async () => {
  let calls = 0
  await expect(
    retry(async () => {
      calls++
      throw new Error('fail')
    }, { maxRetries: 1, delayMs: 10, backoffMultiplier: 1 }),
  ).rejects.toThrow('fail')

  expect(calls).toBe(2) // initial + 1 retry
})

test('uses default options when none provided', async () => {
  let calls = 0
  await expect(
    retry(async () => {
      calls++
      throw new Error('fail')
    }, { delayMs: 10 }), // keep delay short for test
  ).rejects.toThrow('fail')

  expect(calls).toBe(4) // initial + 3 retries (default maxRetries=3)
})
