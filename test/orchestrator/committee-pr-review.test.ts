import { test, expect, describe } from 'bun:test'
import type {
  TaskAdapter,
  GitAdapter,
  LLMAdapter,
  LLMConfig,
  LLMResponse,
  Issue,
  CompanyConfig,
  AgentDefinition,
  StateStore,
  ExecutionState,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import {
  executeCommitteePrReview,
  committeePrReviewEnabled,
  tallyCommitteePrReview,
  type CommitteePrReviewDeps,
  type ExternalVoterHost,
} from '@floor-agents/orchestrator'
import { createCostTracker, DEFAULT_MAX_TURNS, resetLifecycle, stopChildren } from '@floor-agents/orchestrator'
import type { CommitteeVote, CommitteeVoteExecution } from '@floor-agents/orchestrator'
import type { Gateway, TaskResult } from '@floor-agents/gateway'

// ── Mock helpers ────────────────────────────────────────────────────

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: 'issue-1',
    title: 'Add a widget',
    body: 'Implement the widget.',
    status: 'in_progress',
    labels: ['agent'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeVoter(id: string, provider: string = id, external = false): AgentDefinition {
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    promptTemplate: 'agents/committee.md',
    llm: { provider, model: 'test', temperature: 0.3, maxTokens: 4096 },
    capabilities: ['read_code', 'review_rfc', 'vote'],
    autonomy: 'T1',
    customInstructions: '',
    external,
  }
}

function makeReviewer(): AgentDefinition {
  return {
    id: 'cto',
    name: 'CTO',
    promptTemplate: 'agents/cto.md',
    llm: { provider: 'anthropic', model: 'test', temperature: 0.3, maxTokens: 4096 },
    capabilities: ['review_pr'],
    autonomy: 'T1',
    customInstructions: '',
    external: false,
  }
}

function makeState(overrides?: Partial<ExecutionState>): ExecutionState {
  return {
    issueId: 'issue-1',
    agentId: 'developer',
    step: 'creating_pr',
    startedAt: new Date().toISOString(),
    branchName: 'agent/widget',
    commitSha: 'abc123',
    prUrl: 'https://example.com/pr/1',
    prId: '1',
    llmResponse: null,
    parsedOutput: null,
    reviewVerdict: null,
    reviewCycle: 0,
    costUsd: 0,
    error: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function mockTaskAdapter(): TaskAdapter & { comments: Map<string, string[]>; statuses: Map<string, string> } {
  const comments = new Map<string, string[]>()
  const statuses = new Map<string, string>()
  return {
    comments,
    statuses,
    async *watchIssues() {
      await new Promise<never>(() => {})
    },
    async getIssue() { return null },
    async createIssue(data) { return makeIssue({ id: 'new', title: data.title }) },
    async updateIssue() {},
    async addComment(id, text) {
      const list = comments.get(id) ?? []
      list.push(text)
      comments.set(id, list)
    },
    async getComments() { return [] },
    async setStatus(id, status) { statuses.set(id, status) },
    async setLabel() {},
    async removeLabel() {},
  }
}

function mockGitAdapter(): GitAdapter & { prComments: string[]; diffs: string[] } {
  const prComments: string[] = []
  const diffs: string[] = []
  return {
    prComments,
    diffs,
    async getFile() { return null },
    async getTree() { return [] },
    async createBranch() {},
    async commitFiles() { return 'sha' },
    async createPR() {
      return { id: '1', url: '', title: '', body: '', branch: '', status: 'open' }
    },
    async getPRDiff(_repo, prId) {
      diffs.push(prId)
      return 'diff --git a/src/widget.ts b/src/widget.ts\n+export const widget = true'
    },
    async addPRComment(_repo, _prId, body) { prComments.push(body) },
    async mergePR() {},
    async getRecentCommits() { return [] },
  }
}

function mockStateStore(): StateStore {
  const states = new Map<string, ExecutionState>()
  return {
    async get(id) { return states.get(id) ?? null },
    async save(state) { states.set(state.issueId, state) },
    async list() { return [...states.values()] },
  }
}

function mockContextBuilder(): ContextBuilder {
  return {
    async build() {
      return {
        systemPrompt: 'You are a committee member.',
        userMessage: 'Review this.',
        tools: [],
        estimatedTokens: 500,
      }
    },
  }
}

function responseFor(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 50, cost: 0.001 },
    provider: 'anthropic',
    model: 'test',
    durationMs: 20,
  }
}

function llmByProvider(responses: Record<string, string | Error>, seen?: string[]): LLMAdapter {
  return {
    async run(config: LLMConfig): Promise<LLMResponse> {
      const message = config.messages[0]
      if (seen && typeof message?.content === 'string') seen.push(message.content)
      const reply = responses[config.provider]
      if (reply instanceof Error) throw reply
      return responseFor(reply ?? 'I cannot decide.')
    },
  }
}

function makeCompany(agents: AgentDefinition[], review?: CompanyConfig['review']): CompanyConfig {
  return {
    id: 'test-committee-pr',
    name: 'Test Committee PR',
    createdAt: new Date(),
    updatedAt: new Date(),
    project: {
      name: 'test',
      repo: 'test',
      language: 'typescript',
      runtime: 'bun',
      conventions: { semicolons: false, quotes: 'single', indent: 2, modules: 'esm' },
      structure: { backend: 'src/', tests: 'test/' },
      packages: [],
      customInstructions: '',
    },
    agents,
    workflow: { states: [], transitions: [] },
    chain: { nodes: [] },
    autonomy: { default: 'T1', overrides: [] },
    guardrails: {
      maxFilesPerTask: 20,
      maxFileSizeBytes: 102400,
      maxTotalOutputBytes: 512000,
      blockedPaths: [],
      allowedPaths: [],
      blockedExtensions: [],
    },
    costs: { maxCostPerTask: 5, maxCostPerDay: 50, warnCostThreshold: 2 },
    statusMapping: {},
    ...(review ? { review } : {}),
  }
}

function makeDeps(
  agents: AgentDefinition[],
  responses: Record<string, string | Error>,
  extras?: { seen?: string[]; getAdapter?: CommitteePrReviewDeps['getAdapter'] },
): CommitteePrReviewDeps & { task: ReturnType<typeof mockTaskAdapter>; git: ReturnType<typeof mockGitAdapter>; store: StateStore } {
  const task = mockTaskAdapter()
  const git = mockGitAdapter()
  const store = mockStateStore()
  return {
    company: makeCompany(agents),
    taskAdapter: task,
    gitAdapter: git,
    contextBuilder: mockContextBuilder(),
    stateStore: store,
    costTracker: createCostTracker(),
    getAdapter: extras?.getAdapter ?? (() => llmByProvider(responses, extras?.seen)),
    task,
    git,
    store,
  }
}

const four = () => [makeVoter('claude'), makeVoter('codex'), makeVoter('grok'), makeVoter('gemini')]

function vote(
  agentId: string,
  agentName: string,
  v: CommitteeVote['vote'],
  response: string,
  execution?: CommitteeVoteExecution,
): CommitteeVote {
  return {
    agentId,
    agentName,
    vote: v,
    summary: response.slice(0, 500),
    response,
    costUsd: 0,
    execution: execution ?? (v === 'abstain' ? 'failed' : 'answered'),
  }
}

// ── Default: when the committee reviews a PR ────────────────────────

describe('committeePrReviewEnabled', () => {
  test('defaults on when voters sit and no review_pr agent exists', () => {
    expect(committeePrReviewEnabled(makeCompany(four()))).toBe(true)
  })

  test('defaults off when a review_pr agent is seated', () => {
    expect(committeePrReviewEnabled(makeCompany([...four(), makeReviewer()]))).toBe(false)
  })

  test('review.committee: true uses the committee even with a review_pr agent', () => {
    expect(committeePrReviewEnabled(makeCompany([...four(), makeReviewer()], { committee: true }))).toBe(true)
  })

  test('review.committee: false skips the committee even without a review_pr agent', () => {
    expect(committeePrReviewEnabled(makeCompany(four(), { committee: false }))).toBe(false)
  })

  test('off when nobody can vote', () => {
    expect(committeePrReviewEnabled(makeCompany([makeReviewer()]))).toBe(false)
  })
})

describe('tallyCommitteePrReview', () => {
  test('unanimous approve → approve', () => {
    const votes = four().map(a => vote(a.id, a.name, 'approve', 'Looks correct. VOTE: APPROVE'))
    expect(tallyCommitteePrReview(votes).outcome).toBe('approve')
  })

  test('one blocker → request_changes with the blocker in reviewComments', () => {
    const votes = [
      vote('claude', 'Claude', 'approve', 'VOTE: APPROVE'),
      vote('codex', 'Codex', 'approve', 'VOTE: APPROVE'),
      vote('grok', 'Grok', 'approve', 'VOTE: APPROVE'),
      vote('gemini', 'Gemini', 'reject', 'BLOCKER: missing empty-input test\nVOTE: REJECT'),
    ]
    const result = tallyCommitteePrReview(votes)
    expect(result.outcome).toBe('request_changes')
    expect(result.reviewComments).toContain('missing empty-input test')
  })

  test('one abstention out of four still decides', () => {
    const votes = [
      vote('claude', 'Claude', 'approve', 'VOTE: APPROVE'),
      vote('codex', 'Codex', 'approve', 'VOTE: APPROVE'),
      vote('grok', 'Grok', 'approve', 'VOTE: APPROVE'),
      vote('gemini', 'Gemini', 'abstain', 'Error: timed out'),
    ]
    expect(tallyCommitteePrReview(votes).outcome).toBe('approve')
  })

  test('an abstention whose text contains VOTE: APPROVE is not an answer', () => {
    const votes = [
      vote('claude', 'Claude', 'abstain', 'Claude Code error (error_max_turns): Looks good.\nVOTE: APPROVE'),
      vote('codex', 'Codex', 'approve', 'VOTE: APPROVE'),
      vote('grok', 'Grok', 'abstain', 'Error: timed out'),
      vote('gemini', 'Gemini', 'abstain', 'Error: timed out'),
    ]
    expect(tallyCommitteePrReview(votes).outcome).toBe('no_decision')
  })

  test('a failed abstention whose text contains BLOCKER: does not turn a majority approval into request_changes', () => {
    const votes = [
      vote('claude', 'Claude', 'abstain', 'Claude Code error (error_max_turns): BLOCKER: sandbox write\nVOTE: APPROVE', 'failed'),
      vote('codex', 'Codex', 'approve', 'VOTE: APPROVE'),
      vote('grok', 'Grok', 'approve', 'VOTE: APPROVE'),
      vote('gemini', 'Gemini', 'approve', 'VOTE: APPROVE'),
    ]
    const result = tallyCommitteePrReview(votes)
    expect(result.outcome).toBe('approve')
    expect(result.reviewComments).not.toContain('sandbox write')
  })

  test('an answered abstention (no vote marker) whose text contains BLOCKER: still requests changes', () => {
    const votes = [
      vote('claude', 'Claude', 'abstain', 'The sandbox write is wrong.\nBLOCKER: do not write outside the worktree', 'answered'),
      vote('codex', 'Codex', 'approve', 'VOTE: APPROVE'),
      vote('grok', 'Grok', 'approve', 'VOTE: APPROVE'),
      vote('gemini', 'Gemini', 'approve', 'VOTE: APPROVE'),
    ]
    const result = tallyCommitteePrReview(votes)
    expect(result.outcome).toBe('request_changes')
    expect(result.reviewComments).toContain('do not write outside the worktree')
  })

  test('three abstentions → no_decision', () => {
    const votes = [
      vote('claude', 'Claude', 'approve', 'VOTE: APPROVE'),
      vote('codex', 'Codex', 'abstain', 'Error: timed out'),
      vote('grok', 'Grok', 'abstain', 'Error: timed out'),
      vote('gemini', 'Gemini', 'abstain', 'Error: timed out'),
    ]
    expect(tallyCommitteePrReview(votes).outcome).toBe('no_decision')
  })
})

// ── Full review with mock members ───────────────────────────────────

describe('executeCommitteePrReview', () => {
  test('reviewers read the issue discussion: a decision the owner recorded is in front of them', async () => {
    // mtrl #92: the owner had decided the behaviour change under the issue. Reviewers saw only the
    // body, which still said "decide" — Codex blocked three cycles on a point already settled.
    const seen: string[] = []
    const agents = four()
    const deps = makeDeps(agents, { claude: 'VOTE: APPROVE', codex: 'VOTE: APPROVE', grok: 'VOTE: APPROVE', gemini: 'VOTE: APPROVE' }, { seen })
    deps.task.getComments = async () => [
      { id: 'c1', author: 'Dr Jones', body: 'N10: yes — check() clears mixed, in 0.9.8.', createdAt: new Date('2026-09-18T12:00:00Z') },
    ] as never
    await executeCommitteePrReview(makeIssue(), makeState(), deps)
    expect(seen.length).toBeGreaterThan(0)
    for (const prompt of seen) {
      expect(prompt).toContain('## Discussion')
      expect(prompt).toContain('check() clears mixed, in 0.9.8')
      expect(prompt).toContain('not as a BLOCKER')
      // Issue, then discussion, then the diff.
      expect(prompt.indexOf('## Discussion')).toBeLessThan(prompt.indexOf('## PR Diff'))
    }
  })

  test('a blocker that stood through a revision stops the loop for a person', async () => {
    // mtrl #92: Codex wrote the same blocker before and after the revision.
    const before = 'Preserve the existing 0.9.x contract or move the behavior change to the next major release.'
    const after = 'Preserve the existing 0.9.x behavior; move the proposed default behavior change to the next major release.'
    const agents = [makeVoter('claude'), makeVoter('codex')]
    const deps = makeDeps(agents, { claude: 'Fine now. VOTE: APPROVE', codex: `**BLOCKER: ${after}**\nVOTE: REJECT` })
    const labels: string[] = []
    deps.task.setLabel = async (_id, label) => { labels.push(label) }
    const state = makeState({
      commitSha: 'after-revision', reviewCycle: 1,
      reviews: [{
        cycle: 1, at: '2026-09-18T20:40:00Z', commitSha: 'first-pass', durationMs: 1, outcome: 'request_changes',
        votes: [{ agentId: 'codex', agentName: 'Codex', vote: 'reject', blockers: [before] }],
      }],
    })

    const next = await executeCommitteePrReview(makeIssue(), state, deps)

    expect(next.step).toBe('failed')
    expect(next.error).toContain('stood through a revision')
    expect(next.error).toContain('Codex')
    expect(next.reviewCycle).toBe(2)
    expect(labels).toEqual(['needs-human'])
    expect(next.reviews?.at(-1)?.standing).toEqual([`Codex: ${after}`])
    const summary = deps.git.prComments.at(-1)!
    expect(summary).toContain('### Stood through a revision')
    expect(summary).toContain(before)
    expect(summary).toContain('floor-agents review --issue')
    // The issue gets the same words: that is where a person settles the point.
    expect(deps.task.comments.get('issue-1')?.at(-1)).toContain('### Stood through a revision')
  })

  test('new blockers after a revision go to another revision, as before', async () => {
    const agents = [makeVoter('claude'), makeVoter('codex')]
    const deps = makeDeps(agents, { claude: 'VOTE: APPROVE', codex: '**BLOCKER: The CHANGELOG must record the type-level breaks.**\nVOTE: REJECT' })
    const state = makeState({
      commitSha: 'after-revision', reviewCycle: 1,
      reviews: [{
        cycle: 1, at: '2026-09-18T20:40:00Z', commitSha: 'first-pass', durationMs: 1, outcome: 'request_changes',
        votes: [{ agentId: 'codex', agentName: 'Codex', vote: 'reject', blockers: ['Validate the groups callback against the inferred item type at `createVListFromConfig`.'] }],
      }],
    })
    const next = await executeCommitteePrReview(makeIssue(), state, deps)
    expect(next.step).toBe('revision')
    expect(next.reviews?.at(-1)?.standing).toBeUndefined()
    // Each member's blockers are on the record for the cycle after this one.
    expect(next.reviews?.at(-1)?.votes.find(v => v.agentId === 'codex')?.blockers).toEqual(['The CHANGELOG must record the type-level breaks.'])
  })

  test('a stop during the review records nothing: the committee is seated again at the next start', async () => {
    const agents = [makeVoter('claude'), makeVoter('codex')]
    const deps = makeDeps(agents, {}, {
      getAdapter: () => ({
        async run() {
          await stopChildren(0) // SIGTERM: the engine ends the reviewers' processes
          throw new Error('killed')
        },
      }),
    })
    try {
      await expect(executeCommitteePrReview(makeIssue(), makeState(), deps)).rejects.toThrow('stopped during the review')
      expect(deps.git.prComments).toEqual([])
      const saved = await deps.store.get('issue-1')
      expect(saved?.step).toBe('reviewing')
      expect(saved?.reviews ?? []).toEqual([])
    } finally {
      resetLifecycle()
    }
  })

  test('a comments outage does not cost the review', async () => {
    const seen: string[] = []
    const agents = four()
    const deps = makeDeps(agents, { claude: 'VOTE: APPROVE', codex: 'VOTE: APPROVE', grok: 'VOTE: APPROVE', gemini: 'VOTE: APPROVE' }, { seen })
    deps.task.getComments = async () => { throw new Error('Linear is down') }
    const next = await executeCommitteePrReview(makeIssue(), makeState(), deps)
    expect(next.reviewVerdict?.decision).toBe('approve')
    expect(seen.every(p => !p.includes('## Discussion'))).toBe(true)
  })

  test('unanimous approve → approve', async () => {
    const seen: string[] = []
    const agents = four()
    const deps = makeDeps(agents, {
      claude: 'Looks correct. VOTE: APPROVE',
      codex: 'Ship it. VOTE: APPROVE',
      grok: 'Fine. VOTE: APPROVE',
      gemini: 'Agreed. VOTE: APPROVE',
    }, { seen })

    const next = await executeCommitteePrReview(makeIssue(), makeState(), deps)

    expect(next.reviewVerdict?.decision).toBe('approve')
    expect(next.step).toBe('updating_issue')
    expect(deps.git.diffs).toEqual(['1'])
    expect(seen.some(s => s.includes('diff --git a/src/widget.ts'))).toBe(true)
    expect(seen.some(s => s.includes('read the repository only where the diff needs context'))).toBe(true)
    expect(deps.git.prComments.length).toBe(5)
    expect(deps.git.prComments.filter(c => c.includes('**Agent:**')).length).toBe(5)
    expect(deps.git.prComments.at(-1)).toContain('APPROVED')
  })

  test('one blocker → changes_requested with the blocker in reviewComments', async () => {
    const agents = four()
    const deps = makeDeps(agents, {
      claude: 'Looks correct. VOTE: APPROVE',
      codex: 'Ship it. VOTE: APPROVE',
      grok: 'Fine. VOTE: APPROVE',
      gemini: 'The empty case is untested.\nBLOCKER: add an empty-input test\nVOTE: REJECT',
    })

    const next = await executeCommitteePrReview(makeIssue(), makeState(), deps)

    expect(next.step).toBe('revision')
    expect(next.reviewVerdict?.decision).toBe('request_changes')
    expect(next.reviewVerdict?.comments).toContain('add an empty-input test')
    expect(deps.git.prComments.at(-1)).toContain('CHANGES REQUESTED')
    expect(deps.git.prComments.at(-1)).toContain('add an empty-input test')
    expect(deps.task.comments.get('issue-1')?.some(c => c.includes('add an empty-input test'))).toBe(true)
  })

  test('one abstention out of four → still decides', async () => {
    const agents = four()
    const deps = makeDeps(agents, {
      claude: 'VOTE: APPROVE',
      codex: 'VOTE: APPROVE',
      grok: 'VOTE: APPROVE',
      gemini: new Error('gateway timed out'),
    })

    const next = await executeCommitteePrReview(makeIssue(), makeState(), deps)

    expect(next.reviewVerdict?.decision).toBe('approve')
    expect(next.step).toBe('updating_issue')
    expect(deps.git.prComments.some(c => c.includes('ABSTAIN') && c.includes('gateway timed out'))).toBe(true)
  })

  test('a capped Claude turn that contains VOTE: APPROVE abstains rather than approving', async () => {
    const agents = four()
    const deps = makeDeps(agents, {
      claude: new Error('Claude Code error (error_max_turns): Looks correct.\nVOTE: APPROVE'),
      codex: 'VOTE: APPROVE',
      grok: 'VOTE: APPROVE',
      gemini: 'VOTE: APPROVE',
    })

    const next = await executeCommitteePrReview(makeIssue(), makeState(), deps)

    expect(next.reviewVerdict?.decision).toBe('approve')
    // A failed seat is named as one — not as a review that chose to abstain.
    const claudeComment = deps.git.prComments.find(c => c.includes('## Claude did not review'))
    expect(claudeComment).toContain('**Vote:** ABSTAIN')
    expect(claudeComment).toContain('error_max_turns')
    expect(deps.git.prComments.at(-1)).toContain('| Claude | **ABSTAIN** |')
    // The summary says why, from the end of the error — and never quotes a vote marker as the reason.
    expect(deps.git.prComments.at(-1)).toContain('Claude did not review: Error: Claude Code error (error_max_turns): Looks correct.')
  })

  test('a completed review without a vote marker still registers its blockers', async () => {
    const agents = four()
    const deps = makeDeps(agents, {
      claude: 'I have concerns.\nBLOCKER: missing empty-input test',
      codex: 'VOTE: APPROVE',
      grok: 'VOTE: APPROVE',
      gemini: 'VOTE: APPROVE',
    })

    const next = await executeCommitteePrReview(makeIssue(), makeState(), deps)

    expect(next.reviewVerdict?.decision).toBe('request_changes')
    expect(next.reviewVerdict?.comments).toContain('missing empty-input test')
    const claudeComment = deps.git.prComments.find(c => c.includes('## Claude Review'))
    expect(claudeComment).toContain('**Vote:** ABSTAIN')
    expect(deps.git.prComments.at(-1)).toContain('CHANGES REQUESTED')
    expect(deps.git.prComments.at(-1)).toContain('missing empty-input test')
  })

  test('a Claude Code PR review gets the native review turn cap; other providers keep their call unset', async () => {
    const seen: Record<string, number | undefined> = {}
    const agents = [
      makeVoter('claude', 'claude-code'),
      makeVoter('codex'),
      makeVoter('grok'),
      makeVoter('gemini'),
    ]
    const responses = {
      'claude-code': 'VOTE: APPROVE',
      codex: 'VOTE: APPROVE',
      grok: 'VOTE: APPROVE',
      gemini: 'VOTE: APPROVE',
    }
    const inner = llmByProvider(responses)
    const deps = makeDeps(agents, responses, {
      getAdapter: (provider: string) => ({
        async run(config: LLMConfig) {
          seen[provider] = config.maxTurns
          return inner.run(config)
        },
      }),
    })

    const next = await executeCommitteePrReview(makeIssue(), makeState(), deps)

    expect(next.reviewVerdict?.decision).toBe('approve')
    expect(Object.keys(seen).sort()).toEqual(['claude-code', 'codex', 'gemini', 'grok'])
    expect(seen['claude-code']).toBe(DEFAULT_MAX_TURNS.review)
    expect(DEFAULT_MAX_TURNS.review).toBe(60)
    expect(seen['codex']).toBeUndefined()
    expect(seen['grok']).toBeUndefined()
    expect(seen['gemini']).toBeUndefined()
  })

  test('a capped Claude turn that contains BLOCKER: does not request changes when others approve', async () => {
    const agents = four()
    const deps = makeDeps(agents, {
      claude: new Error('Claude Code error (error_max_turns): BLOCKER: sandbox write\nVOTE: APPROVE'),
      codex: 'VOTE: APPROVE',
      grok: 'VOTE: APPROVE',
      gemini: 'VOTE: APPROVE',
    })

    const next = await executeCommitteePrReview(makeIssue(), makeState(), deps)

    expect(next.reviewVerdict?.decision).toBe('approve')
    expect(next.reviewVerdict?.comments).not.toContain('sandbox write')
    expect(deps.git.prComments.at(-1)).toContain('APPROVED')
    // The failed seat's error is quoted as the reason it did not review — never as a blocker.
    expect(deps.git.prComments.at(-1)).not.toContain('### Blockers')
    expect(deps.git.prComments.at(-1)).toContain('Claude did not review:')
  })

  test('three abstentions → in_review, no verdict', async () => {
    const agents = four()
    const deps = makeDeps(agents, {
      claude: 'VOTE: APPROVE',
      codex: new Error('timed out'),
      grok: new Error('timed out'),
      gemini: new Error('timed out'),
    })

    const next = await executeCommitteePrReview(makeIssue(), makeState(), deps)

    expect(next.reviewVerdict).toBeNull()
    expect(next.step).toBe('updating_issue')
    expect(deps.task.statuses.get('issue-1')).toBe('in_review')
    expect(deps.git.prComments.at(-1)).toContain('NO DECISION')
    expect(deps.git.prComments.at(-1)).toContain('Left for human review')
  })
})

describe('executeCommitteePrReview — external voter bridges', () => {
  test('votes from a fake bridge are counted in the tally', async () => {
    const trace = { started: 0, stopped: 0 }
    let resolvePending: ((result: TaskResult) => void) | undefined
    const gateway: Gateway = {
      start() {},
      stop() {},
      assign(_agentId, task) {
        resolvePending?.({
          taskId: task.id,
          agentId: _agentId,
          content: 'Looks correct from the bridge. VOTE: APPROVE',
          receivedAt: new Date(),
        })
      },
      waitForResult() {
        return new Promise<TaskResult>(resolve => { resolvePending = resolve })
      },
      getConnectedAgents() { return [] },
      isAgentConnected() { return true },
      onAgentConnect() {},
      onAgentDisconnect() {},
    }
    const host: ExternalVoterHost = {
      async start(agents) {
        trace.started++
        expect(agents.map(a => a.id)).toEqual(['codex'])
        return {
          gateway,
          started: new Map([['codex', { ok: true as const }]]),
          stop() { trace.stopped++ },
        }
      },
    }

    const agents = [makeVoter('claude'), makeVoter('codex', 'codex-cli', true)]
    const deps = makeDeps(agents, { claude: 'Looks correct. VOTE: APPROVE' })
    const next = await executeCommitteePrReview(makeIssue(), makeState(), { ...deps, externalVoters: host })

    expect(trace.started).toBe(1)
    expect(trace.stopped).toBe(1)
    expect(next.reviewVerdict?.decision).toBe('approve')
    expect(deps.git.prComments.some(c => c.includes('Looks correct from the bridge'))).toBe(true)
    expect(deps.git.prComments.at(-1)).toContain('APPROVED')
  })

  test('a bridge that fails to start abstains at once with the reason on the PR', async () => {
    const trace = { started: 0, stopped: 0 }
    const host: ExternalVoterHost = {
      async start(agents) {
        trace.started++
        return {
          started: new Map(agents.map(a => [a.id, { ok: false as const, reason: 'codex CLI not found' }])),
          stop() { trace.stopped++ },
        }
      },
    }

    const agents = [makeVoter('claude'), makeVoter('codex', 'codex-cli', true)]
    const deps = makeDeps(agents, { claude: 'Looks correct. VOTE: APPROVE' })
    deps.task.getComments = async () => { throw new Error('must not poll') }

    const started = Date.now()
    const next = await executeCommitteePrReview(makeIssue(), makeState(), { ...deps, externalVoters: host })

    expect(Date.now() - started).toBeLessThan(1000)
    expect(trace.stopped).toBe(1)
    expect(next.reviewVerdict).toBeNull()
    expect(deps.git.prComments.some(c => c.includes('ABSTAIN') && c.includes('codex CLI not found'))).toBe(true)
    expect(deps.git.prComments.at(-1)).toContain('NO DECISION')
  })
})
