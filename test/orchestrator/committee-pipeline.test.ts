import { test, expect, describe } from 'bun:test'
import type {
  TaskAdapter,
  LLMAdapter,
  LLMConfig,
  LLMResponse,
  Issue,
  CompanyConfig,
  AgentDefinition,
  StateStore,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import { executeCommitteeReview, type CommitteePipelineDeps } from '@floor-agents/orchestrator'
import { createCostTracker } from '@floor-agents/orchestrator'

// ── Mock helpers ────────────────────────────────────────────────────

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: 'rfc-1',
    title: 'RFC-003: New caching strategy',
    body: 'Proposal to replace the size cache with a B-tree.\n\nSee discussions/42',
    status: 'backlog',
    labels: ['committee'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeAgent(id: string, provider: string = 'anthropic'): AgentDefinition {
  return {
    id,
    name: `Agent ${id}`,
    promptTemplate: 'agents/committee.md',
    llm: { provider, model: 'test', temperature: 0.3, maxTokens: 4096 },
    capabilities: ['read_code', 'review_rfc', 'vote'],
    autonomy: 'T1',
    customInstructions: '',
  }
}

function mockTaskAdapter(): TaskAdapter & { comments: Map<string, string[]>; statuses: Map<string, string>; labels: Map<string, string[]> } {
  const comments = new Map<string, string[]>()
  const statuses = new Map<string, string>()
  const labels = new Map<string, string[]>()

  return {
    comments,
    statuses,
    labels,

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
    async setStatus(id, status) { statuses.set(id, status) },
    async setLabel(id, label) {
      const list = labels.get(id) ?? []
      list.push(label)
      labels.set(id, list)
    },
    async removeLabel() {},
  }
}

function mockLLMAdapter(responseContent: string): LLMAdapter {
  return {
    async run(_config: LLMConfig): Promise<LLMResponse> {
      return {
        content: responseContent,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 500, outputTokens: 200, cost: 0.005 },
        provider: 'anthropic',
        model: 'test',
        durationMs: 50,
      }
    },
  }
}

function mockStateStore(): StateStore {
  const states = new Map()
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

function makeDeps(
  llmResponse: string,
  overrides?: Partial<CommitteePipelineDeps>,
): CommitteePipelineDeps {
  const llm = mockLLMAdapter(llmResponse)
  return {
    company: {
      name: 'Test Committee',
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
      agents: [makeAgent('claude'), makeAgent('gemini'), makeAgent('gpt')],
      workflow: { states: [], transitions: [] },
      chain: { nodes: [] },
      autonomy: { default: 'T1', overrides: [] },
      guardrails: {
        maxFilesPerTask: 0,
        maxFileSizeBytes: 0,
        maxTotalOutputBytes: 0,
        blockedPaths: ['*'],
        allowedPaths: [],
        blockedExtensions: ['*'],
      },
      costs: { maxCostPerTask: 2, maxCostPerDay: 20, warnCostThreshold: 1 },
      statusMapping: {},
    },
    taskAdapter: mockTaskAdapter(),
    contextBuilder: mockContextBuilder(),
    stateStore: mockStateStore(),
    costTracker: createCostTracker(),
    getAdapter: () => llm,
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('vote extraction', () => {
  test('all approve → approved', async () => {
    const deps = makeDeps('This looks solid. **VOTE: APPROVE**')
    const agents = [makeAgent('claude'), makeAgent('gemini'), makeAgent('gpt')]

    const result = await executeCommitteeReview(makeIssue(), agents, deps)

    expect(result.outcome).toBe('approved')
    expect(result.votes.length).toBe(3)
    expect(result.votes.every(v => v.vote === 'approve')).toBe(true)
  })

  test('all reject → rejected', async () => {
    const deps = makeDeps('Major issues remain. VOTE: REJECT')
    const agents = [makeAgent('claude'), makeAgent('gemini'), makeAgent('gpt')]

    const result = await executeCommitteeReview(makeIssue(), agents, deps)

    expect(result.outcome).toBe('rejected')
    expect(result.votes.every(v => v.vote === 'reject')).toBe(true)
  })

  test('2 approve + 1 reject → approved (majority)', async () => {
    let callCount = 0
    const llm: LLMAdapter = {
      async run(): Promise<LLMResponse> {
        callCount++
        const content = callCount <= 2
          ? 'Looks good. VOTE: APPROVE'
          : 'Missing details. VOTE: REJECT'
        return {
          content,
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 500, outputTokens: 200, cost: 0.005 },
          provider: 'anthropic',
          model: 'test',
          durationMs: 50,
        }
      },
    }

    const deps = makeDeps('', { getAdapter: () => llm })
    const agents = [makeAgent('claude'), makeAgent('gemini'), makeAgent('gpt')]

    const result = await executeCommitteeReview(makeIssue(), agents, deps)

    expect(result.outcome).toBe('approved')
    expect(result.votes.filter(v => v.vote === 'approve').length).toBe(2)
    expect(result.votes.filter(v => v.vote === 'reject').length).toBe(1)
  })

  test('1 approve + 2 reject → rejected', async () => {
    let callCount = 0
    const llm: LLMAdapter = {
      async run(): Promise<LLMResponse> {
        callCount++
        const content = callCount === 1
          ? 'Looks good. VOTE: APPROVE'
          : 'Critical gap. VOTE: REJECT'
        return {
          content,
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 500, outputTokens: 200, cost: 0.005 },
          provider: 'anthropic',
          model: 'test',
          durationMs: 50,
        }
      },
    }

    const deps = makeDeps('', { getAdapter: () => llm })
    const agents = [makeAgent('claude'), makeAgent('gemini'), makeAgent('gpt')]

    const result = await executeCommitteeReview(makeIssue(), agents, deps)

    expect(result.outcome).toBe('rejected')
  })

  test('no vote keyword → abstain', async () => {
    const deps = makeDeps('I need more information before I can decide.')
    const agents = [makeAgent('claude')]

    const result = await executeCommitteeReview(makeIssue(), agents, deps)

    expect(result.votes[0]!.vote).toBe('abstain')
    expect(result.outcome).toBe('no_quorum')
  })

  test('case insensitive vote parsing', async () => {
    const deps = makeDeps('vote: approve')
    const agents = [makeAgent('claude')]

    const result = await executeCommitteeReview(makeIssue(), agents, deps)

    expect(result.votes[0]!.vote).toBe('approve')
    expect(result.outcome).toBe('approved')
  })
})

describe('task updates', () => {
  test('posts committee started comment', async () => {
    const taskAdapter = mockTaskAdapter()
    const deps = makeDeps('VOTE: APPROVE', { taskAdapter })
    const agents = [makeAgent('claude')]

    await executeCommitteeReview(makeIssue(), agents, deps)

    const comments = taskAdapter.comments.get('rfc-1') ?? []
    expect(comments.some(c => c.includes('Committee Review Started'))).toBe(true)
  })

  test('posts individual responses', async () => {
    const taskAdapter = mockTaskAdapter()
    const deps = makeDeps('My technical analysis. VOTE: APPROVE', { taskAdapter })
    const agents = [makeAgent('claude'), makeAgent('gemini')]

    await executeCommitteeReview(makeIssue(), agents, deps)

    const comments = taskAdapter.comments.get('rfc-1') ?? []
    expect(comments.some(c => c.includes('My technical analysis'))).toBe(true)
  })

  test('posts vote tally', async () => {
    const taskAdapter = mockTaskAdapter()
    const deps = makeDeps('VOTE: APPROVE', { taskAdapter })
    const agents = [makeAgent('claude'), makeAgent('gemini')]

    await executeCommitteeReview(makeIssue(), agents, deps)

    const comments = taskAdapter.comments.get('rfc-1') ?? []
    expect(comments.some(c => c.includes('Vote Results'))).toBe(true)
    expect(comments.some(c => c.includes('APPROVE'))).toBe(true)
  })

  test('sets status to done on approval', async () => {
    const taskAdapter = mockTaskAdapter()
    const deps = makeDeps('VOTE: APPROVE', { taskAdapter })
    const agents = [makeAgent('claude')]

    await executeCommitteeReview(makeIssue(), agents, deps)

    expect(taskAdapter.statuses.get('rfc-1')).toBe('done')
    expect(taskAdapter.labels.get('rfc-1')).toContain('approved')
  })

  test('sets rejected label on rejection', async () => {
    const taskAdapter = mockTaskAdapter()
    const deps = makeDeps('VOTE: REJECT', { taskAdapter })
    const agents = [makeAgent('claude')]

    await executeCommitteeReview(makeIssue(), agents, deps)

    expect(taskAdapter.labels.get('rfc-1')).toContain('rejected')
  })
})

describe('cost tracking', () => {
  test('tracks total cost across all agents', async () => {
    const deps = makeDeps('VOTE: APPROVE')
    const agents = [makeAgent('claude'), makeAgent('gemini'), makeAgent('gpt')]

    const result = await executeCommitteeReview(makeIssue(), agents, deps)

    // Each mock agent costs $0.005
    expect(result.totalCost).toBeCloseTo(0.015, 3)
  })

  test('records cost per vote', async () => {
    const deps = makeDeps('VOTE: APPROVE')
    const agents = [makeAgent('claude')]

    const result = await executeCommitteeReview(makeIssue(), agents, deps)

    expect(result.votes[0]!.costUsd).toBeCloseTo(0.005, 3)
  })
})

describe('error handling', () => {
  test('agent error results in abstain', async () => {
    const failLLM: LLMAdapter = {
      async run(): Promise<LLMResponse> {
        throw new Error('API rate limited')
      },
    }

    const deps = makeDeps('', { getAdapter: () => failLLM })
    const agents = [makeAgent('claude')]

    const result = await executeCommitteeReview(makeIssue(), agents, deps)

    expect(result.votes[0]!.vote).toBe('abstain')
    expect(result.votes[0]!.summary).toContain('API rate limited')
    expect(result.outcome).toBe('no_quorum')
  })

  test('partial failure: 2 succeed + 1 fails → still tallies', async () => {
    let callCount = 0
    const mixedLLM: LLMAdapter = {
      async run(): Promise<LLMResponse> {
        callCount++
        if (callCount === 3) throw new Error('timeout')
        return {
          content: 'VOTE: APPROVE',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 500, outputTokens: 200, cost: 0.005 },
          provider: 'anthropic',
          model: 'test',
          durationMs: 50,
        }
      },
    }

    const deps = makeDeps('', { getAdapter: () => mixedLLM })
    const agents = [makeAgent('claude'), makeAgent('gemini'), makeAgent('gpt')]

    const result = await executeCommitteeReview(makeIssue(), agents, deps)

    expect(result.votes.filter(v => v.vote === 'approve').length).toBe(2)
    expect(result.votes.filter(v => v.vote === 'abstain').length).toBe(1)
    expect(result.outcome).toBe('approved')
  })
})

describe('discussions sync', () => {
  test('syncs to linked discussion on approval', async () => {
    const posted: { id: string; body: string }[] = []
    const mockDiscussions = {
      async getDiscussion(number: number) {
        if (number === 42) {
          return {
            id: 'D_123',
            number: 42,
            title: 'RFC-003',
            body: '',
            comments: [],
          }
        }
        return null
      },
      async postComment(id: string, body: string) {
        posted.push({ id, body })
        return { id: 'C_1', author: 'bot', body, createdAt: '', url: '' }
      },
      async listDiscussions() { return [] },
    }

    const deps = makeDeps('VOTE: APPROVE', { discussions: mockDiscussions })
    const agents = [makeAgent('claude')]
    const issue = makeIssue({ body: 'See discussions/42 for context' })

    await executeCommitteeReview(issue, agents, deps)

    expect(posted.length).toBe(1)
    expect(posted[0]!.id).toBe('D_123')
    expect(posted[0]!.body).toContain('APPROVED')
  })

  test('skips sync when no discussion linked', async () => {
    const posted: { id: string; body: string }[] = []
    const mockDiscussions = {
      async getDiscussion() { return null },
      async postComment(id: string, body: string) {
        posted.push({ id, body })
        return { id: 'C_1', author: 'bot', body, createdAt: '', url: '' }
      },
      async listDiscussions() { return [] },
    }

    const deps = makeDeps('VOTE: APPROVE', { discussions: mockDiscussions })
    const agents = [makeAgent('claude')]
    const issue = makeIssue({ body: 'No discussion link here' })

    await executeCommitteeReview(issue, agents, deps)

    expect(posted.length).toBe(0)
  })
})
