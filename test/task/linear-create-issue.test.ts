import { afterEach, describe, expect, test } from 'bun:test'
import { createLinearAdapter } from '../../packages/task/src/linear/index.ts'

type Asked = { query: string; variables: Record<string, unknown> }

/** A Linear that knows one team, one project and two labels, and remembers what it was asked. */
function fakeLinear() {
  const asked: Asked[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as Asked
      asked.push(body)
      if (body.query.includes('teams(')) return Response.json({ data: { teams: { nodes: body.variables.key === 'FLO' ? [{ id: 'team-uuid-0001', key: 'FLO' }] : [] } } })
      if (body.query.includes('projects(')) return Response.json({ data: { projects: { nodes: [{ id: 'project-vlist', name: 'vlist' }] } } })
      if (body.query.includes('issueLabels(')) return Response.json({ data: { issueLabels: { nodes: [{ id: 'label-team', name: 'area/carousel' }, { id: 'label-workspace', name: 'finding' }] } } })
      if (body.query.includes('issueCreate')) {
        return Response.json({ data: { issueCreate: { issue: {
          id: 'new-id', identifier: 'FLO-300', url: 'https://linear.app/x/issue/FLO-300', title: 'T', description: 'B',
          state: { name: 'Backlog', type: 'backlog' }, labels: { nodes: [] }, parent: null,
          createdAt: '2026-09-19T12:00:00.000Z', updatedAt: '2026-09-19T12:00:00.000Z',
        } } } })
      }
      return Response.json({ errors: [{ message: 'unexpected query' }] })
    },
  })
  return { asked, baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

let stop: (() => void) | undefined
afterEach(() => { stop?.(); stop = undefined })

describe('linear: createIssue', () => {
  test('a team named by its key is created under the team’s id, in the manifest’s project, with its labels', async () => {
    const linear = fakeLinear()
    stop = linear.stop
    const adapter = createLinearAdapter({ apiKey: 'k', teamId: 'FLO', projectName: 'vlist', baseUrl: linear.baseUrl })

    const issue = await adapter.createIssue({ title: 'T', body: 'B', labels: ['finding', 'area/carousel', 'no-such-label'] })
    expect(issue.key).toBe('FLO-300')

    const created = linear.asked.find(a => a.query.includes('issueCreate'))!
    // Measured before the fix: `teamId: "FLO"` — "Argument Validation Error" — and no projectId at all.
    expect(created.variables.input).toMatchObject({
      teamId: 'team-uuid-0001', projectId: 'project-vlist', title: 'T', description: 'B',
      labelIds: ['label-workspace', 'label-team'],
    })
  })

  test('labels are looked up in the team and in the workspace: a workspace label is a label', async () => {
    const linear = fakeLinear()
    stop = linear.stop
    const adapter = createLinearAdapter({ apiKey: 'k', teamId: 'FLO', baseUrl: linear.baseUrl })
    await adapter.createIssue({ title: 'T', labels: ['finding'] })
    const labels = linear.asked.find(a => a.query.includes('issueLabels('))!
    expect(labels.query).toContain('team: { null: true }')
  })

  test('a team id is used as it is; an unknown key says so', async () => {
    const linear = fakeLinear()
    stop = linear.stop
    const byId = createLinearAdapter({ apiKey: 'k', teamId: 'aaaa-bbbb', baseUrl: linear.baseUrl })
    await byId.createIssue({ title: 'T' })
    expect((linear.asked.find(a => a.query.includes('issueCreate'))!.variables.input as { teamId: string }).teamId).toBe('aaaa-bbbb')
    expect(linear.asked.some(a => a.query.includes('teams('))).toBe(false)

    const unknown = createLinearAdapter({ apiKey: 'k', teamId: 'NOPE', baseUrl: linear.baseUrl })
    await expect(unknown.createIssue({ title: 'T' })).rejects.toThrow('no team with key "NOPE"')
  })
})
