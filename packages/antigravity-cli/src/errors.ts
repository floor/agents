export class MalformedReviewError extends Error {
  readonly rawOutputTail: string

  constructor(message: string, rawOutputTail: string) {
    super(message)
    this.name = 'MalformedReviewError'
    this.rawOutputTail = rawOutputTail
  }
}

export class AntigravityTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(message: string, timeoutMs: number) {
    super(message)
    this.name = 'AntigravityTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class AntigravityProcessError extends Error {
  readonly exitCode: number | null
  readonly stderr: string

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message)
    this.name = 'AntigravityProcessError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/**
 * Thrown when the Antigravity CLI's own settings file (see README.md) does
 * not carry a `permissions.deny` policy covering both `write_file(*)` and
 * `command(*)` — the CLI has no read-only sandbox flag of its own, so this
 * reviewer refuses to spawn `agy` at all rather than run unsandboxed.
 */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyError'
  }
}

/**
 * Thrown when `git status --porcelain` is non-empty in the worktree right
 * after a run — the deny policy (see `PolicyError`) is supposed to prevent
 * any write, so a dirty worktree means either that policy failed to apply
 * or something outside `agy` itself touched the directory. Either way this
 * reviewer refuses to trust (or return) the review rather than silently
 * accept it.
 */
export class WorktreeModifiedError extends Error {
  readonly dir: string
  readonly gitStatusPorcelain: string

  constructor(message: string, dir: string, gitStatusPorcelain: string) {
    super(message)
    this.name = 'WorktreeModifiedError'
    this.dir = dir
    this.gitStatusPorcelain = gitStatusPorcelain
  }
}
