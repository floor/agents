import { afterEach, describe, expect, test } from 'bun:test'
import { createLinearAdapter } from '../../packages/task/src/linear/index.ts'

type Asked = { query: string; variables: Record<string, unknown> }

/** A Linear that answers from a script, and remembers what it was asked. */
function fakeLinear(pages: unknown[][]) {
  const asked: Asked[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as Asked
      asked.push(body)
      if (body.query.includes('projects(')) return Response.json({ data: { projects: { nodes: [{ id: 'project-mtrl', name: 'mtrl' }] } } })
      const page = pages.shift() ?? []
      return Response.json({ data: { issues: { nodes: page, pageInfo: { hasNextPage: pages.length > 0, endCursor: `cursor-${pages.length}` } } } })
    },
  })
  return { asked, baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const node = (n: number, over: Record<string, unknown> = {}) => ({
  id: `id-${n}`, identifier: `FLO-${n}`, url: `https://linear.app/floor-io/issue/FLO-${n}`, title: `Issue ${n}`, description: null,
  state: { name: 'Todo', type: 'unstarted' }, labels: { nodes: [] }, parent: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z', ...over,
})

let stop: (() => void) | undefined
afterEach(() => { stop?.(); stop = undefined })

describe('linear: listOpenIssues', () => {
  test('the project’s unfinished issues, whatever their labels, with state name, milestone and priority', async () => {
    const linear = fakeLinear([[
      node(96, { state: { name: 'In Review', type: 'started' }, priority: 3, projectMilestone: { name: '0.9.8' }, labels: { nodes: [{ name: 'agent' }] } }),
      node(97, { priority: 0, projectMilestone: null }),
    ]])
    stop = linear.stop
    const adapter = createLinearAdapter({ apiKey: 'k', teamId: 'FLO', projectName: 'mtrl', baseUrl: linear.baseUrl })
    const issues = await adapter.listOpenIssues!()

    expect(issues.map(i => [i.key, i.status, i.stateName, i.milestone, i.priority, i.labels])).toEqual([
      ['FLO-96', 'in_progress', 'In Review', '0.9.8', 3, ['agent']],
      ['FLO-97', 'triage', 'Todo', undefined, undefined, []],
    ])
    const query = linear.asked.at(-1)!
    // Scoped to the manifest's project, open states only, and no label filter: the to-do list, not the queue.
    expect(query.variables).toMatchObject({ teamId: 'FLO', projectId: 'project-mtrl' })
    expect(query.query).toContain('nin: ["completed", "canceled"]')
    expect(query.query).not.toContain('labels:')
  })

  test('a backlog longer than a page is read to its end', async () => {
    const linear = fakeLinear([[node(1), node(2)], [node(3)]])
    stop = linear.stop
    const adapter = createLinearAdapter({ apiKey: 'k', teamId: 'FLO', projectName: 'mtrl', baseUrl: linear.baseUrl })
    expect((await adapter.listOpenIssues!()).map(i => i.key)).toEqual(['FLO-1', 'FLO-2', 'FLO-3'])
    expect(linear.asked.filter(a => a.query.includes('issues(')).map(a => a.variables.after)).toEqual([null, 'cursor-1'])
  })

  test('a cancelled issue reads as done (Linear spells the state type with one l)', async () => {
    const linear = fakeLinear([])
    stop = linear.stop
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ data: { issue: node(5, { state: { name: 'Canceled', type: 'canceled' } }) } }),
    })
    try {
      const adapter = createLinearAdapter({ apiKey: 'k', teamId: 'FLO', baseUrl: `http://127.0.0.1:${server.port}` })
      expect((await adapter.getIssue('id-5'))?.status).toBe('done')
    } finally {
      server.stop(true)
    }
  })
})
