export type GuardrailsConfig = {
  readonly maxFilesPerTask: number
  readonly maxFileSizeBytes: number
  readonly maxTotalOutputBytes: number
  readonly blockedPaths: readonly string[]
  readonly allowedPaths: readonly string[]
  readonly blockedExtensions: readonly string[]
  /**
   * Providers trusted with private sources. An agent whose `llm.provider` is not
   * listed may not read them: its sandbox denies those paths. Absent means none.
   */
  readonly privateSourceProviders?: readonly string[]
}

export type GuardrailViolation = {
  readonly type:
    | 'too_many_files'
    | 'file_too_large'
    | 'total_too_large'
    | 'blocked_path'
    | 'outside_allowed_paths'
    | 'blocked_extension'
    | 'path_traversal'
  readonly detail: string
  readonly file?: string
}
