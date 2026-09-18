import { describe, expect, test } from 'bun:test'
import type { AgentDefinition, CompanyConfig, ExecutionState, Issue } from '@floor-agents/core'
import { belongsTo, createApiServer, phaseOf, runDetail, runSummary, agentView, type ApiIssues, type ApiProject, type ApiRunDetail, type ApiRuns } from '@floor-agents/api'

const agent = (id: string, capabilities: string[], external = false): AgentDefinition => ({
  id, name: id, promptTemplate: '', llm: { provider: 'cursor', model: 'grok', temperature: 0, maxTokens: 1 },
  capabilities: capabilities as AgentDefinition['capabilities'], autonomy: 'T1', customInstructions: '', ...(external ? { external } : {}),
})

const company = {
  project: { name: 'mtrl', repo: 'floor/mtrl', baseBranch: 'main' },
  agents: [agent('grok-dev', ['read_code', 'write_code']), agent('claude', ['review_rfc', 'vote']), agent('codex', ['vote'], true), agent('cto', ['review_rfc'])],
} as unknown as CompanyConfig

const issue = (id: string, key: string, over: Partial<Issue> = {}): Issue => ({
  id, key, title: `Title of ${key}`, body: '', status: 'backlog', labels: [], stateName: 'Backlog',
  createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-18T10:00:00Z'), ...over,
})

const state = (issueId: string, over: Partial<ExecutionState> = {}): ExecutionState => ({
  issueId, agentId: 'grok-dev', step: 'done', startedAt: '2026-09-18T20:00:00Z', updatedAt: '2026-09-18T20:10:00Z',
  branchName: 'agent/x', commitSha: 'abc', prUrl: null, prId: null, llmResponse: 'a very long transcript', parsedOutput: null,
  reviewVerdict: null, reviewCycle: 0, costUsd: 1.5, error: null, ...over,
})

const approved: Partial<ExecutionState> = {
  repo: 'floor/mtrl', issueKey: 'FLO-96', issueTitle: 'N10', prUrl: 'https://github.com/floor/mtrl/pull/93',
  attempts: [{
    n: 1, kind: 'implement', agentId: 'grok-dev', model: 'grok', startedAt: '2026-09-18T20:00:00Z', endedAt: '2026-09-18T20:06:00Z',
    baseSha: 'b', turnMs: 222_000, outcome: 'published', commitSha: '83e6820a', sessionId: 's',
    gates: [{ at: '2026-09-18T20:05:00Z', treeSha: 't', passed: true, durationMs: 110_000, checks: [{ name: 'Tests', exitCode: 0, timedOut: false, durationMs: 60_000 }] }],
  }],
  reviews: [{
    cycle: 1, at: '2026-09-18T20:08:00Z', commitSha: '83e6820a', durationMs: 94_000, outcome: 'approve',
    votes: [{ agentId: 'claude', agentName: 'Claude', vote: 'approve' }, { agentId: 'codex', agentName: 'Codex', vote: 'approve' }],
  }],
}

function server(opts: { issues?: Issue[] | Error; states?: ExecutionState[]; token?: string; noList?: boolean } = {}) {
  let asked = 0
  const api = createApiServer({
    company, taskSource: 'linear', triggerLabels: ['agent'], mode: 'serve', version: '0.1.0', maxRuns: 2, maxReviewCycles: 3,
    stateStore: { get: async id => (opts.states ?? []).find(s => s.issueId === id) ?? null, list: async () => opts.states ?? [] },
    taskAdapter: opts.noList ? {} : {
      listOpenIssues: async () => {
        asked++
        if (opts.issues instanceof Error) throw opts.issues
        return opts.issues ?? []
      },
    },
    ...(opts.token ? { token: opts.token } : {}),
  })
  const get = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
    const res = await api.handle(new Request(`http://127.0.0.1${path}`, init))
    return { status: res.status, body: await res.json() as T }
  }
  return { get, asked: () => asked }
}

describe('GET /api/v1/project', () => {
  test('the project, the engine and the team with each agent’s role', async () => {
    const { status, body } = await server().get<ApiProject>('/api/v1/project')
    expect(status).toBe(200)
    expect(body).toMatchObject({
      name: 'mtrl', repo: 'floor/mtrl', baseBranch: 'main', taskSource: 'linear', triggerLabels: ['agent'],
      engine: { mode: 'serve', version: '0.1.0', api: 'v1' }, limits: { maxRuns: 2, maxReviewCycles: 3 },
    })
    expect(body.team.map(a => [a.id, a.role, a.external])).toEqual([
      ['grok-dev', 'implementer', false], ['claude', 'committee member', false], ['codex', 'committee member', true], ['cto', 'reviewer', false],
    ])
  })
})

describe('GET /api/v1/issues', () => {
  test('the open issues of the task source, each with its run when it has one', async () => {
    const { body } = await server({
      issues: [issue('i-96', 'FLO-96', { labels: ['Agent'], stateName: 'In Review', milestone: '0.9.8', priority: 3 }), issue('i-97', 'FLO-97')],
      states: [state('i-96', approved)],
    }).get<ApiIssues>('/api/v1/issues')
    expect(body.source).toBe('task-source')
    expect(body.issues.map(i => [i.key, i.stateName, i.milestone, i.queued, i.run?.phase ?? null])).toEqual([
      ['FLO-96', 'In Review', '0.9.8', true, 'done'], ['FLO-97', 'Backlog', null, false, null],
    ])
  })

  test('a run in progress whose issue is no longer listed is still shown; a finished one is not', async () => {
    const { body } = await server({
      issues: [issue('i-97', 'FLO-97')],
      states: [state('i-1', { repo: 'floor/mtrl', step: 'reviewing', issueKey: 'FLO-1', issueTitle: 'Closed by hand' }), state('i-2', { repo: 'floor/mtrl', step: 'done' })],
    }).get<ApiIssues>('/api/v1/issues')
    expect(body.issues.map(i => i.key)).toEqual(['FLO-97', 'FLO-1'])
    expect(body.issues[1]).toMatchObject({ title: 'Closed by hand', status: 'unknown', run: { phase: 'reviewing' } })
  })

  test('a task source that is down does not take the panel down: the recorded runs are listed, and it says why', async () => {
    const { status, body } = await server({ issues: new Error('Linear: 503'), states: [state('i-96', approved)] }).get<ApiIssues>('/api/v1/issues')
    expect(status).toBe(200)
    expect(body).toMatchObject({ source: 'runs', sourceError: 'Linear: 503' })
    expect(body.issues.map(i => i.key)).toEqual(['FLO-96'])
  })

  test('a task source that cannot list issues lists the runs', async () => {
    const { body } = await server({ noList: true, states: [state('i-96', approved)] }).get<ApiIssues>('/api/v1/issues')
    expect(body.source).toBe('runs')
    expect(body.sourceError).toContain('cannot list issues')
    expect(body.issues).toHaveLength(1)
  })

  test('a panel that polls does not become a load on the task source', async () => {
    const s = server({ issues: [issue('i-97', 'FLO-97')] })
    await s.get('/api/v1/issues')
    await s.get('/api/v1/issues')
    await s.get('/api/v1/runs')
    expect(s.asked()).toBe(1)
  })
})

describe('GET /api/v1/runs', () => {
  test('this project’s runs only, newest first, from a state directory several projects share', async () => {
    const { body } = await server({
      issues: [issue('i-old', 'FLO-50')],
      states: [
        state('i-96', { ...approved, updatedAt: '2026-09-18T20:10:00Z' }),
        state('v-1', { repo: 'floor/vlist', prUrl: 'https://github.com/floor/vlist/pull/261' }),
        state('v-2', { prUrl: 'https://github.com/floor/vlist/pull/259' }),        // older record: recognised by its pull request
        state('m-old', { prUrl: 'https://github.com/floor/mtrl/pull/85', updatedAt: '2026-09-18T09:00:00Z' }),
        state('i-old', { prUrl: null, step: 'failed', updatedAt: '2026-09-18T08:00:00Z' }), // no repo, no PR: an issue the project lists
        state('nobody', { prUrl: null }),
      ],
    }).get<ApiRuns>('/api/v1/runs')
    expect(body.runs.map(r => r.issueId)).toEqual(['i-96', 'm-old', 'i-old'])
  })

  test('one run in full, by key or by id — without the agent’s transcript', async () => {
    const s = server({ states: [state('i-96', approved)] })
    const byKey = await s.get<ApiRunDetail>('/api/v1/runs/flo-96')
    expect(byKey.status).toBe(200)
    expect(byKey.body).toMatchObject({
      issueKey: 'FLO-96', phase: 'done', attempts: 1, reviews: 1, workMs: 222_000 + 110_000 + 94_000,
      lastAttempt: { gate: 'passed', turnMs: 222_000, commit: '83e6820a' },
      lastReview: { outcome: 'approve', votes: [{ agent: 'Claude', vote: 'approve', failed: false }, { agent: 'Codex', vote: 'approve', failed: false }] },
    })
    expect(byKey.body.attemptList[0]!.gates[0]!.checks[0]).toEqual({ name: 'Tests', passed: true, timedOut: false, durationMs: 60_000, tail: null })
    expect(JSON.stringify(byKey.body)).not.toContain('a very long transcript')
    expect((await s.get<ApiRunDetail>('/api/v1/runs/i-96')).body.issueKey).toBe('FLO-96')
    expect((await s.get('/api/v1/runs/FLO-404')).status).toBe(404)
  })
})

describe('the door', () => {
  test('read-only, versioned, and closed to a request without the token when one is set', async () => {
    const open = server()
    expect((await open.get('/api/v1/health')).body).toEqual({ ok: true, project: 'mtrl', mode: 'serve' })
    expect((await open.get('/api/v1/issues', { method: 'POST' })).status).toBe(405)
    expect((await open.get('/api/v2/issues')).status).toBe(404)
    expect((await open.get('/api/v1/nothing')).status).toBe(404)
    const closed = server({ token: 'secret' })
    expect((await closed.get('/api/v1/project')).status).toBe(401)
    expect((await closed.get('/api/v1/project', { headers: { authorization: 'Bearer secret' } })).status).toBe(200)
  })
})

describe('phaseOf', () => {
  const running = (over: Record<string, unknown>) => ({ n: 1, kind: 'implement' as const, agentId: 'a', model: 'm', startedAt: '', baseSha: '', gates: [], outcome: 'running' as const, ...over })
  test('what a person wants to know at a glance', () => {
    expect(phaseOf(state('i', { step: 'calling_llm', attempts: [running({})] }))).toBe('working')
    expect(phaseOf(state('i', { step: 'calling_llm', attempts: [running({ turnMs: 1 })] }))).toBe('verifying')
    expect(phaseOf(state('i', { step: 'calling_llm', attempts: [running({ kind: 'revision' })] }))).toBe('revising')
    expect(phaseOf(state('i', { step: 'reviewing' }))).toBe('reviewing')
    expect(phaseOf(state('i', { step: 'done' }))).toBe('done')
    expect(phaseOf(state('i', { step: 'failed', error: 'Verification failed: Tests (exit 1)' }))).toBe('failed')
  })

  test('a run that waits for a person says so, whatever step it ended on', () => {
    const review = (over: Record<string, unknown>) => ({ cycle: 1, at: '', commitSha: null, durationMs: 1, votes: [], outcome: 'request_changes', ...over })
    expect(phaseOf(state('i', { step: 'done', reviews: [review({ outcome: 'no_decision' })] }))).toBe('needs-person')
    expect(phaseOf(state('i', { step: 'failed', error: 'A blocker stood…', reviews: [review({ standing: ['Codex: …'] })] }))).toBe('needs-person')
    expect(phaseOf(state('i', { step: 'failed', error: 'Max review cycles reached; needs human review' }))).toBe('needs-person')
  })
})

describe('views', () => {
  test('belongsTo: the repository it names, else its pull request, else an issue the project lists', () => {
    expect(belongsTo(state('a', { repo: 'floor/mtrl' }), 'floor/mtrl', new Set())).toBe(true)
    expect(belongsTo(state('a', { repo: 'floor/vlist', prUrl: 'https://github.com/floor/mtrl/pull/1' }), 'floor/mtrl', new Set())).toBe(false)
    expect(belongsTo(state('a', { prUrl: 'https://github.com/floor/mtrl/pull/1' }), 'floor/mtrl', new Set())).toBe(true)
    expect(belongsTo(state('a', { prUrl: 'https://github.com/floor/mtrl-app/pull/1' }), 'floor/mtrl', new Set())).toBe(false)
    expect(belongsTo(state('a'), 'floor/mtrl', new Set(['a']))).toBe(true)
    expect(belongsTo(state('a'), 'floor/mtrl', new Set())).toBe(false)
  })

  test('a summary carries the first line of an error, not the log', () => {
    expect(runSummary(state('a', { step: 'failed', error: 'Verification failed: Tests\n…4,000 lines…' })).error).toBe('Verification failed: Tests')
    expect(runDetail(state('a')).attemptList).toEqual([])
    expect(agentView(agent('x', ['read_code'])).role).toBe('member')
  })
})
