export class MalformedReviewError extends Error {
  readonly rawOutputTail: string

  constructor(message: string, rawOutputTail: string) {
    super(message)
    this.name = 'MalformedReviewError'
    this.rawOutputTail = rawOutputTail
  }
}

export class CodexTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(message: string, timeoutMs: number) {
    super(message)
    this.name = 'CodexTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class CodexProcessError extends Error {
  readonly exitCode: number | null
  readonly stderr: string

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message)
    this.name = 'CodexProcessError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

// WorktreeMismatchError moved to @floor-agents/core (see review/errors.ts)
// once @floor-agents/antigravity-cli needed the exact same worktree
// lifecycle and error type — re-exported from this package's index.ts so
// `import { WorktreeMismatchError } from '@floor-agents/codex-cli'` keeps
// working unchanged.
