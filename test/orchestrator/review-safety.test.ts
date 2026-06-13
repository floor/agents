import { test, expect, describe } from 'bun:test'
import type {
  GitAdapter,
  TaskAdapter,
  LLMAdapter,
  LLMResponse,
  Issue,
  CompanyConfig,
  AgentDefinition,
  StateStore,
  ExecutionState,
  ToolCall,
} from '@floor-agents/core'
import { runReviewAgent, type ReviewDeps } from '@floor-agents/orchestrator'
import { createCostTracker } from '@floor-agents/orchestrator'

// ── Mock helpers ────────────────────────────────────────────────────

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: 'issue-1',
    title: 'Add a widget',
    body: 'Implement the widget.',
    status: 'in_progress',
    labels: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
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
    agentId: 'cto',
    step: 'creating_pr',
    startedAt: new Date().toISOString(),
    branchName: 'feat/widget',
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

function mockTaskAdapter(): TaskAdapter {
  const comments = new Map<string, string[]>()
  return {
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
    async setStatus() {},
    async setLabel() {},
    async removeLabel() {},
  }
}

function mockGitAdapter(): GitAdapter {
  return {
    async getFile() { return null },
    async getTree() { return [] },
    async createBranch() {},
    async commitFiles() { return 'sha' },
    async createPR() {
      return { id: '1', url: '', title: '', body: '', branch: '', status: 'open' }
    },
    async getPRDiff() { return 'diff --git a/x b/x\n+added line' },
    async addPRComment() {},
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

/**
 * LLM adapter that returns the supplied tool calls (defaults to none) and never
 * a `review_verdict` — the scenario that previously silently approved.
 */
function mockLLMAdapter(toolCalls: ToolCall[] = []): LLMAdapter {
  return {
    async run(): Promise<LLMResponse> {
      return {
        content: 'I looked at the diff but did not submit a verdict.',
        toolCalls,
        stopReason: 'end_turn',
        usage: { inputTokens: 500, outputTokens: 200, cost: 0.005 },
        provider: 'anthropic',
        model: 'test',
        durationMs: 50,
      }
    },
  }
}

function makeCompany(): CompanyConfig {
  return {
    id: 'test-co',
    name: 'Test Co',
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
    agents: [makeReviewer()],
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
  }
}

function makeDeps(llm: LLMAdapter): ReviewDeps {
  return {
    company: makeCompany(),
    gitAdapter: mockGitAdapter(),
    taskAdapter: mockTaskAdapter(),
    stateStore: mockStateStore(),
    costTracker: createCostTracker(),
    getAdapter: () => llm,
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('review fails closed', () => {
  test('no review_verdict tool call → request_changes (not approve)', async () => {
    const deps = makeDeps(mockLLMAdapter([]))

    const next = await runReviewAgent(makeIssue(), makeReviewer(), makeState(), deps)

    expect(next.reviewVerdict).not.toBeNull()
    expect(next.reviewVerdict!.decision).toBe('request_changes')
    // A failing-closed verdict must route to revision, never to merge.
    expect(next.step).toBe('revision')
  })

  test('explicit review_verdict approve still approves', async () => {
    const approveCall: ToolCall = {
      id: 'tc-1',
      name: 'review_verdict',
      input: { decision: 'approve', comments: 'Looks good.' },
    }
    const deps = makeDeps(mockLLMAdapter([approveCall]))

    const next = await runReviewAgent(makeIssue(), makeReviewer(), makeState(), deps)

    expect(next.reviewVerdict!.decision).toBe('approve')
    expect(next.step).toBe('updating_issue')
  })
})
