/**
 * Where a project's tasks live.
 *
 * Declared in the manifest, because it is a property of the project: vlist's
 * findings and TODOs sit in Linear, another project's may be GitHub issues,
 * and a third may not use an agent queue at all. Secrets do not live here —
 * the API key comes from the project's `.agents/.env`.
 */
export type TaskSource = 'linear' | 'github-issues' | 'things'

export type TasksConfig = {
  readonly source: TaskSource
  /** Labels that hand an issue to the implementer in `watch` mode. Default: `agent`. */
  readonly labels?: readonly string[]
  readonly linear?: {
    /** Team key (`FLO`) or id. */
    readonly team: string
    /** Project name or id; issues outside it are not this project's. */
    readonly project?: string
  }
  readonly github?: {
    /** Repository holding the issues, when not the project's own. */
    readonly repo?: string
  }
}
