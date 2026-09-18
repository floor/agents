export type ProjectConventions = {
  readonly style?: string
  readonly modules?: string
  readonly indent?: number
  readonly semicolons?: boolean
  readonly quotes?: string
  readonly css?: string
  readonly framework?: string
  readonly testRunner?: string
  readonly commentsLanguage?: string
}

export type ProjectStructure = {
  readonly backend?: string
  readonly frontend?: string
  readonly tests?: string
  readonly schemas?: string
  readonly config?: string
}

/** Native implementer repair turns after a gate failure. `0` disables repair. */
export const DEFAULT_FIX_TURNS = 1

export type ProjectConfig = {
  /** Absolute checkout path after loading; YAML paths are relative to the config. */
  readonly root?: string
  readonly owner?: string
  readonly baseBranch?: string
  readonly setup?: readonly ProjectCommand[]
  readonly verification?: readonly ProjectCommand[]
  /**
   * How many times a native implementer may be called again on the same
   * worktree after a structured gate failure. Default 1; `0` disables repair.
   * Each implementer turn (first pass and each review revision) gets its own allowance.
   */
  readonly fixTurns?: number
  readonly name: string
  readonly repo: string
  readonly language: string
  readonly runtime: string
  readonly conventions: ProjectConventions
  readonly structure: ProjectStructure
  readonly packages: readonly string[]
  readonly customInstructions: string
}

/** Commands run directly, without a shell, in the isolated checkout. */
export type ProjectCommand = {
  readonly name: string
  readonly command: readonly string[]
  readonly timeoutMs?: number
  /** If true, a non-zero exit or timeout is retried once before it counts. */
  readonly flaky?: boolean
}
