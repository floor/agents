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
  readonly name: string
  readonly repo: string
  readonly language: string
  readonly runtime: string
  readonly conventions: ProjectConventions
  readonly structure: ProjectStructure
  readonly packages: readonly string[]
  readonly customInstructions: string
}
