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
} from '@floor-agents/orchestrator'
import { createCostTracker } from '@floor-agents/orchestrator'
import type { CommitteeVote } from '@floor-agents/orchestrator'

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

function makeVoter(id: string, provider: string = id): AgentDefinition {
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    promptTemplate: 'agents/committee.md',
    llm: { provider, model: 'test', temperature: 0.3, maxTokens: 4096 },
    capabilities: ['read_code', 'review_rfc', 'vote'],
    autonomy: 'T1',
    customInstructions: '',
    external: false,
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
  extras?: { seen?: string[] },
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
    getAdapter: () => llmByProvider(responses, extras?.seen),
    task,
    git,
    store,
  }
}

const four = () => [makeVoter('claude'), makeVoter('codex'), makeVoter('grok'), makeVoter('gemini')]

function vote(agentId: string, agentName: string, v: CommitteeVote['vote'], response: string): CommitteeVote {
  return { agentId, agentName, vote: v, summary: response.slice(0, 500), response, costUsd: 0 }
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
