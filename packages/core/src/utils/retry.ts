export type RetryOptions = {
  readonly maxRetries?: number
  readonly delayMs?: number
  readonly backoffMultiplier?: number
}

export async function retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3
  const delayMs = options?.delayMs ?? 1000
  const backoffMultiplier = options?.backoffMultiplier ?? 2

  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === maxRetries) break
      const delay = delayMs * Math.pow(backoffMultiplier, attempt)
      await new Promise(r => setTimeout(r, delay))
    }
  }

  throw lastError
}
