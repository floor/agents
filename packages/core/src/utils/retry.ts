export type RetryOptions = {
  maxRetries?: number
  delayMs?: number
  backoffMultiplier?: number
}

export async function retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const defaultOptions: RetryOptions = {
    maxRetries: 3
    delayMs: 1000
    backoffMultiplier: 2
  }
  const opts = { ...defaultOptions, ...options }

  let lastError: unknown

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === opts.maxRetries) {
        throw lastError
      }

      const delay = opts.delayMs * Math.pow(opts.backoffMultiplier, attempt)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  // This line should technically be unreachable if the loop logic is correct, but for completeness:
  throw lastError
}
