/**
 * The project API: a small read-only HTTP service in every engine process.
 *
 * One engine process serves one project — its manifest, its task source, its
 * recorded runs. A control panel asks each project's process what it is doing;
 * nothing is pushed, nothing is written. It listens on the loopback interface
 * only: the answers name branches, worktrees and the ends of failing test runs.
 */

import type { CompanyConfig, ExecutionState, Issue, StateStore, TaskAdapter } from '@floor-agents/core'
import { repoSlug } from '@floor-agents/core'
import { API_VERSION, type ApiError, type ApiIssues, type ApiProject, type ApiRuns, type EngineMode } from './types.ts'
import { agentView, belongsTo, issueFromRun, issueView, runDetail, runSummary } from './views.ts'

export const DEFAULT_API_PORT = 3110

export type ApiServerOptions = {
  readonly company: CompanyConfig
  readonly stateStore: Pick<StateStore, 'get' | 'list'>
  /** Asked for the open issues. Without `listOpenIssues` only issues that have a run are listed. */
  readonly taskAdapter: Pick<TaskAdapter, 'listOpenIssues'>
  readonly taskSource: string
  readonly triggerLabels: readonly string[]
  readonly mode: EngineMode
  readonly version: string
  readonly maxRuns: number
  readonly maxReviewCycles: number
  readonly port?: number
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  readonly token?: string
  /** How long a list of open issues is reused before the task source is asked again. */
  readonly issuesTtlMs?: number
  readonly now?: () => Date
}

export type ApiServer = {
  start(): void
  stop(): void
  getPort(): number | undefined
  /** The router, for tests and for mounting elsewhere. */
  handle(req: Request): Promise<Response>
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
})

const fail = (status: number, error: string): Response => json({ error } satisfies ApiError, status)

export function createApiServer(options: ApiServerOptions): ApiServer {
  const { company, stateStore, taskAdapter } = options
  const repo = repoSlug(company.project, process.env.GITHUB_OWNER)
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const ttl = options.issuesTtlMs ?? 15_000
  let server: { stop(force?: boolean): void; readonly port?: number } | null = null
  let cached: { at: number; issues: Issue[] } | null = null

  /** The task source is asked at most once per `ttl`: a panel that polls must not become a load on it. */
  async function openIssues(): Promise<{ issues: Issue[]; error: string | null; asked: boolean }> {
    if (!taskAdapter.listOpenIssues) return { issues: [], error: `the ${options.taskSource} task source cannot list issues`, asked: false }
    if (cached && now().getTime() - cached.at < ttl) return { issues: cached.issues, error: null, asked: true }
    try {
      cached = { at: now().getTime(), issues: await taskAdapter.listOpenIssues() }
      return { issues: cached.issues, error: null, asked: true }
    } catch (err) {
      // A task source that is down does not take the panel down with it: the runs are local.
      return { issues: cached?.issues ?? [], error: err instanceof Error ? err.message : String(err), asked: Boolean(cached) }
    }
  }

  async function projectRuns(issueIds: ReadonlySet<string>): Promise<ExecutionState[]> {
    const all = await stateStore.list()
    return all.filter(s => belongsTo(s, repo, issueIds)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  function project(): ApiProject {
    return {
      name: company.project.name,
      repo,
      baseBranch: company.project.baseBranch ?? 'main',
      taskSource: options.taskSource,
      triggerLabels: [...options.triggerLabels],
      engine: { version: options.version, mode: options.mode, pid: process.pid, startedAt, api: API_VERSION },
      limits: { maxRuns: options.maxRuns, maxReviewCycles: options.maxReviewCycles },
      team: company.agents.map(agentView),
    }
  }

  async function issues(): Promise<ApiIssues> {
    const open = await openIssues()
    const ids = new Set(open.issues.map(i => i.id))
    const runs = await projectRuns(ids)
    const byIssue = new Map(runs.map(r => [r.issueId, r]))
    const listed = open.issues.map(i => issueView(i, byIssue.get(i.id), options.triggerLabels))
    // A run in progress whose issue the task source did not list (closed by hand,
    // or the source is down) is still work in progress, and is still shown.
    const unlisted = runs.filter(r => !ids.has(r.issueId) && (!open.asked || (r.step !== 'done' && r.step !== 'failed')))
    return {
      generatedAt: now().toISOString(),
      source: open.asked && !open.error ? 'task-source' : 'runs',
      sourceError: open.error,
      issues: [...listed, ...unlisted.map(issueFromRun)],
    }
  }

  async function runs(): Promise<ApiRuns> {
    const open = await openIssues()
    const list = await projectRuns(new Set(open.issues.map(i => i.id)))
    return { generatedAt: now().toISOString(), runs: list.map(runSummary) }
  }

  async function run(idOrKey: string): Promise<Response> {
    const wanted = idOrKey.toLowerCase()
    const open = await openIssues()
    const list = await projectRuns(new Set(open.issues.map(i => i.id)))
    const found = list.find(s => s.issueId.toLowerCase() === wanted || s.issueKey?.toLowerCase() === wanted)
      // Older runs did not record their key: the task source knows it.
      ?? list.find(s => open.issues.some(i => i.id === s.issueId && i.key?.toLowerCase() === wanted))
    return found ? json(runDetail(found)) : fail(404, `no run recorded for ${idOrKey}`)
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const prefix = `/api/${API_VERSION}`
    if (!url.pathname.startsWith(`${prefix}/`)) return fail(404, `unknown path; the API lives under ${prefix}/`)
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'the project API is read-only')
    if (options.token && req.headers.get('authorization') !== `Bearer ${options.token}`) return fail(401, 'missing or wrong bearer token')

    const path = url.pathname.slice(prefix.length)
    try {
      if (path === '/health') return json({ ok: true, project: company.project.name, mode: options.mode })
      if (path === '/project') return json(project())
      if (path === '/issues') return json(await issues())
      if (path === '/runs') return json(await runs())
      const one = path.match(/^\/runs\/([^/]+)$/)
      if (one) return await run(decodeURIComponent(one[1]!))
      return fail(404, `unknown path ${url.pathname}`)
    } catch (err) {
      return fail(500, err instanceof Error ? err.message : String(err))
    }
  }

  return {
    start() {
      server = Bun.serve({ hostname: '127.0.0.1', port: options.port ?? DEFAULT_API_PORT, fetch: handle })
      console.log(`[api] ${company.project.name}: http://127.0.0.1:${server.port}/api/${API_VERSION}/ (${options.mode})`)
    },
    stop() {
      server?.stop(true)
      server = null
    },
    getPort() {
      return server?.port
    },
    handle,
  }
}
