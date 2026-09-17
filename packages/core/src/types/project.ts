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

export type ProjectConfig = {
  /** Absolute checkout path after loading; YAML paths are relative to the config. */
  readonly root?: string
  readonly owner?: string
  readonly baseBranch?: string
  readonly setup?: readonly ProjectCommand[]
  readonly verification?: readonly ProjectCommand[]
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
}
