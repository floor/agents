import { retry } from '../src/utils/retry'

describe('retry', () => {
  // Mock implementation for testing purposes
  let attemptCount = 0
  let mockFn: () => Promise<string>

  beforeEach(() => {
    attemptCount = 0
    mockFn = () => {
      attemptCount++
      return Promise.resolve('success')
    }
  })

  test('should return the result of fn when it succeeds on the first attempt', async () => {
    const result = await retry(mockFn)
    expect(result).toBe('success')
    expect(attemptCount).toBe(1)
  })

  test('should retry and succeed after some failures with default settings', async () => {
    // Setup mock to fail twice then succeed on the third attempt (default maxRetries is 3, so 3 attempts total)
    let callCount = 0
    mockFn = () => {
      callCount++
      if (callCount < 3) {
        throw new Error('transient error')
      }
      return 'success'
    }

    const result = await retry(mockFn)
    expect(result).toBe('success')
    expect(callCount).toBe(3)
  })

  test('should throw the last error if all retries fail', async () => {
    // Setup mock to always fail
    let callCount = 0
    mockFn = () => {
      callCount++
      throw new Error('permanent failure')
    }

    await expect(retry(mockFn, { maxRetries: 2, delayMs: 10 }))
      .rejects.toThrow('permanent failure')
    expect(callCount).toBe(3) // Should attempt 3 times (0, 1, 2 retries)
  })

  test('should use exponential backoff', async () => {
    let callCount = 0
    const delaySpy = jest.spyOn(global, 'setTimeout')

    // We expect 3 attempts: initial + 2 retries
    mockFn = () => {
      callCount++
      return Promise.reject(new Error('error'))
    }

    await retry(mockFn, { maxRetries: 2, delayMs: 100, backoffMultiplier: 2 })

    // Check delays:
    // Attempt 1 fails, waits 100 * 2^0 = 100ms (if we consider the wait before retry) or just checks if setTimeout was called correctly.
    // The implementation waits *after* catching the error and before the next attempt.

    // Wait for the first delay (after first failure, before second attempt)
    expect(delaySpy).toHaveBeenCalledWith(expect.any(Function), 100)

    // Wait for the second delay (after second failure, before third attempt)
    expect(delaySpy).toHaveBeenCalledWith(expect.any(Function), 200)

    // Total calls should be maxRetries + 1 = 3 attempts
    expect(callCount).toBe(3)

    delaySpy.mockRestore()
  })

  test('should use default settings if options are omitted', async () => {
    let callCount = 0
    mockFn = () => {
      callCount++
      throw new Error('error')
    }

    // Default maxRetries is 3
    await retry(mockFn)
    expect(callCount).toBe(4) // 1 initial + 3 retries (total 4 calls if it fails all 3 times and throws the last error, or 3 attempts total depending on how we count. Let's stick to the implementation logic: loop runs for attempt=0, 1, 2, 3. If it fails at attempt=3, it throws.)
    // Re-evaluating the implementation: loop runs for attempt=0 up to opts.maxRetries (inclusive). If maxRetries=3, attempts are 0, 1, 2, 3. Total 4 calls if we count the final failed call.

    // Let's re-verify the retry logic based on the implementation:
    /*
      for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try { ... } catch (error) {
          if (attempt === opts.maxRetries) { throw lastError } // Throws on the final failed attempt
          await new Promise(...) // Waits before next attempt
        }
      }
    */

    // If maxRetries=3, it tries 4 times (0, 1, 2, 3). The loop structure seems to allow for N+1 attempts if we count the final throw. Let's adjust expectations based on standard retry patterns where maxRetries is the number of *retries*.

    // If we want 3 total tries (1 initial + 2 retries), maxRetries should be 2.
    // If default maxRetries=3 means 3 retries, total attempts = 4. Let's test with maxRetries=2 for a clean failure case.

    let callCount2 = 0
    mockFn = () => {
      callCount2++
      throw new Error('error')
    }

    await expect(retry(mockFn, { maxRetries: 2, delayMs: 10 }))
      .rejects.toThrow('error')
    expect(callCount2).toBe(3) // Attempts 0, 1, 2. Fails on attempt 2 and throws. This looks correct for N retries.

  })
})