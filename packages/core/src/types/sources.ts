/**
 * Material agents consult beside the repository: findings, notes, a record.
 *
 * A private source is kept off public issues, and it is kept away from model
 * providers the project has not trusted with it. Whatever an agent reads becomes
 * part of a prompt sent to its provider, so visibility decides which providers
 * may read a source at all, not only where its content is published.
 */
export type SourceVisibility = 'public' | 'private'

export type SourceDefinition = {
  /** Absolute after loading; YAML paths are relative to the manifest. */
  readonly path: string
  readonly format?: string
  /** A source that does not say otherwise is private. */
  readonly visibility: SourceVisibility
}
