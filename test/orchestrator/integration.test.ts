import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import type {
  TaskAdapter,
  GitAdapter,
  LLMAdapter,
  LLMConfig,
  LLMResponse,
  Issue,
  IssueEvent,
  CompanyConfig,
  FileContent,
  FileEntry,
  PullRequest,
} from '@floor-agents/core'
import { loadCompanyConfig } from '@floor-agents/core'
import { createContextBuilder } from '@floor-agents/context-builder'
import { createOrchestrator, createCostTracker, createStateStore } from '@floor-agents/orchestrator'

const STATE_DIR = './data/test-integration'

// ── Mock helpers ────────────────────────────────────────────────────

function mockIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: 'issue-1',
    title: 'Add a slugify utility function',
    body: 'Create a slugify function in src/utils/slugify.ts',
    status: 'backlog',
    labels: ['backend'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function mockTaskAdapter(issues: Issue[]): TaskAdapter & { comments: Map<string, string[]>; statuses: Map<string, string>; labels: Map<string, string[]> } {
  const comments = new Map<string, string[]>()
  const statuses = new Map<string, string>()
  const labels = new Map<string, string[]>()
  let yielded = false

  return {
    comments,
    statuses,
    labels,

    async *watchIssues() {
      if (!yielded) {
        yielded = true
        for (const issue of issues) {
          yield { type: 'created' as const, issue }
        }
      }
      // Block forever after yielding initial issues
      await new Promise<never>(() => {})
    },

    async getIssue(id) {
      return issues.find(i => i.id === id) ?? null
    },

    async createIssue(data) {
      return mockIssue({ id: `new-${Date.now()}`, title: data.title, body: data.body ?? '' })
    },

    async updateIssue() {},

    async addComment(id, text) {
      const list = comments.get(id) ?? []
      list.push(text)
      comments.set(id, list)
    },

    async setStatus(id, status) {
      statuses.set(id, status)
    },

    async setLabel(id, label) {
      const list = labels.get(id) ?? []
      list.push(label)
      labels.set(id, list)
    },

    async removeLabel() {},
  }
}

function mockGitAdapter(): GitAdapter & { branches: string[]; commits: { branch: string; files: string[] }[]; prs: PullRequest[] } {
  const branches: string[] = []
  const commits: { branch: string; files: string[] }[] = []
  const prs: PullRequest[] = []

  return {
    branches,
    commits,
    prs,

    async getFile(repo, path): Promise<FileContent | null> {
      if (path === 'src/utils/slugify.ts') {
        return { path, content: '// existing file', encoding: 'utf-8' }
      }
      return null
    },

    async getTree(): Promise<FileEntry[]> {
      return [
        { path: 'src', type: 'dir' },
        { path: 'src/utils', type: 'dir' },
        { path: 'src/index.ts', type: 'file', size: 100 },
        { path: 'test', type: 'dir' },
      ]
    },

    async createBranch(_repo, name) {
      branches.push(name)
    },

    async commitFiles(_repo, branch, files, _message) {
      commits.push({ branch, files: files.map(f => f.path) })
      return 'abc123def456'
    },

    async createPR(_repo, branch, title, body) {
      const pr: PullRequest = {
        id: '42',
        url: `https://github.com/test/repo/pull/42`,
        title,
        body,
        branch,
        status: 'open',
      }
      prs.push(pr)
      return pr
    },

    async getPRDiff() { return '' },
    async addPRComment() {},
    async mergePR() {},
    async getRecentCommits() { return [] },
  }
}

function mockLLMAdapter(toolCalls: LLMResponse['toolCalls'] = []): LLMAdapter {
  return {
    async run(config: LLMConfig): Promise<LLMResponse> {
      return {
        content: 'Here is my implementation.',
        toolCalls: toolCalls.length > 0 ? toolCalls : [
          {
            id: 'tc-1',
            name: 'write_file',
            input: { path: 'src/utils/slugify.ts', content: 'export function slugify(text: string): string {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, \'-\')\n}\n' },
          },
          {
            id: 'tc-2',
            name: 'pr_description',
            input: { title: 'Add slugify utility', description: 'Adds a slugify function to src/utils/slugify.ts' },
          },
        ],
        stopReason: 'end_turn',
        usage: { inputTokens: 1000, outputTokens: 500, cost: 0.01 },
        provider: 'anthropic',
        model: 'test-model',
        durationMs: 100,
      }
    },
  }
}

// ── Setup / teardown ────────────────────────────────────────────────

beforeEach(async () => {
  await mkdir(STATE_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(STATE_DIR, { recursive: true, force: true })
})

async function loadTestConfig(): Promise<CompanyConfig> {
  return loadCompanyConfig('config/templates/default.yaml')
}

// ── Tests ───────────────────────────────────────────────────────────

test('happy path: issue → LLM → branch → PR → status update', async () => {
  const issue = mockIssue()
  const taskAdapter = mockTaskAdapter([issue])
  const gitAdapter = mockGitAdapter()
  const llmAdapter = mockLLMAdapter()
  const company = await loadTestConfig()

  const contextBuilder = createContextBuilder({
    taskAdapter,
    gitAdapter,
  })

  const orchestrator = createOrchestrator({
    company,
    taskAdapter,
    gitAdapter,
    llmAdapters: new Map([['anthropic', llmAdapter]]),
    contextBuilder,
    stateStore: createStateStore(STATE_DIR),
    costTracker: createCostTracker(),
  })

  // Run orchestrator with a timeout to avoid hanging
  const timeout = setTimeout(() => orchestrator.stop(), 2000)
  await orchestrator.start()
  clearTimeout(timeout)

  // Verify branch was created
  expect(gitAdapter.branches.length).toBe(1)
  expect(gitAdapter.branches[0]).toStartWith('agent/')

  // Verify files were committed
  expect(gitAdapter.commits.length).toBe(1)
  expect(gitAdapter.commits[0]!.files).toContain('src/utils/slugify.ts')

  // Verify PR was created
  expect(gitAdapter.prs.length).toBe(1)
  expect(gitAdapter.prs[0]!.title).toBe('Add a slugify utility function')

  // Verify task was updated
  expect(taskAdapter.statuses.get('issue-1')).toBe('in_review')
  expect(taskAdapter.comments.get('issue-1')?.some(c => c.includes('PR created'))).toBe(true)
})

test('guardrail violation: blocked path prevents PR creation', async () => {
  const issue = mockIssue()
  const taskAdapter = mockTaskAdapter([issue])
  const gitAdapter = mockGitAdapter()
  const company = await loadTestConfig()

  // LLM tries to write to a blocked path
  const llmAdapter = mockLLMAdapter([
    {
      id: 'tc-1',
      name: 'write_file',
      input: { path: '.env.local', content: 'SECRET=oops' },
    },
  ])

  const contextBuilder = createContextBuilder({
    taskAdapter,
    gitAdapter,
  })

  const orchestrator = createOrchestrator({
    company,
    taskAdapter,
    gitAdapter,
    llmAdapters: new Map([['anthropic', llmAdapter]]),
    contextBuilder,
    stateStore: createStateStore(STATE_DIR),
    costTracker: createCostTracker(),
  })

  const timeout = setTimeout(() => orchestrator.stop(), 2000)
  await orchestrator.start()
  clearTimeout(timeout)

  // PR should NOT be created
  expect(gitAdapter.prs.length).toBe(0)

  // Issue should be commented with violation
  const comments = taskAdapter.comments.get('issue-1') ?? []
  expect(comments.some(c => c.includes('Guardrail'))).toBe(true)

  // Issue should be labeled needs-human
  const issueLabels = taskAdapter.labels.get('issue-1') ?? []
  expect(issueLabels).toContain('needs-human')
})

test('no tool calls: retries once then fails', async () => {
  const issue = mockIssue()
  const taskAdapter = mockTaskAdapter([issue])
  const gitAdapter = mockGitAdapter()
  const company = await loadTestConfig()
  let callCount = 0

  // LLM returns no tool calls on both attempts
  const llmAdapter: LLMAdapter = {
    async run(): Promise<LLMResponse> {
      callCount++
      return {
        content: 'I cannot use tools right now.',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 500, outputTokens: 200, cost: 0.005 },
        provider: 'anthropic',
        model: 'test-model',
        durationMs: 50,
      }
    },
  }

  const contextBuilder = createContextBuilder({
    taskAdapter,
    gitAdapter,
  })

  const orchestrator = createOrchestrator({
    company,
    taskAdapter,
    gitAdapter,
    llmAdapters: new Map([['anthropic', llmAdapter]]),
    contextBuilder,
    stateStore: createStateStore(STATE_DIR),
    costTracker: createCostTracker(),
  })

  const timeout = setTimeout(() => orchestrator.stop(), 2000)
  await orchestrator.start()
  clearTimeout(timeout)

  // Should have called LLM twice (initial + retry)
  expect(callCount).toBe(2)

  // PR should NOT be created
  expect(gitAdapter.prs.length).toBe(0)

  // Issue should be commented with failure
  const comments = taskAdapter.comments.get('issue-1') ?? []
  expect(comments.some(c => c.includes('could not produce structured output'))).toBe(true)
})

test('daily cost limit: skips new tasks', async () => {
  const issue = mockIssue()
  const taskAdapter = mockTaskAdapter([issue])
  const gitAdapter = mockGitAdapter()
  const llmAdapter = mockLLMAdapter()
  const company = await loadTestConfig()

  // Pre-exhaust the daily budget
  const costTracker = createCostTracker()
  costTracker.recordCost('old-task', company.costs.maxCostPerDay + 1)

  const contextBuilder = createContextBuilder({
    taskAdapter,
    gitAdapter,
  })

  const orchestrator = createOrchestrator({
    company,
    taskAdapter,
    gitAdapter,
    llmAdapters: new Map([['anthropic', llmAdapter]]),
    contextBuilder,
    stateStore: createStateStore(STATE_DIR),
    costTracker,
  })

  const timeout = setTimeout(() => orchestrator.stop(), 2000)
  await orchestrator.start()
  clearTimeout(timeout)

  // PR should NOT be created — task was skipped
  expect(gitAdapter.prs.length).toBe(0)

  // Issue should be commented about cost limit
  const comments = taskAdapter.comments.get('issue-1') ?? []
  expect(comments.some(c => c.includes('cost limit'))).toBe(true)
})

test('crash recovery: resumes from saved state', async () => {
  const issue = mockIssue()
  const gitAdapter = mockGitAdapter()
  const llmAdapter = mockLLMAdapter()
  const company = await loadTestConfig()

  const stateStore = createStateStore(STATE_DIR)

  // Simulate a crash after creating_branch by saving state
  await stateStore.save({
    issueId: 'issue-1',
    agentId: 'backend',
    step: 'committing_files',
    startedAt: new Date().toISOString(),
    branchName: 'agent/add-a-slugify-utility-function',
    commitSha: null,
    prUrl: null,
    llmResponse: 'Here is my implementation.',
    parsedOutput: {
      rawResponse: 'Here is my implementation.',
      files: [{ path: 'src/utils/slugify.ts', content: 'export function slugify() {}' }],
      prDescription: 'Adds slugify',
      parseErrors: [],
    },
    costUsd: 0.01,
    error: null,
    updatedAt: new Date().toISOString(),
  })

  // Create a new task adapter that returns our issue when queried
  const taskAdapter = mockTaskAdapter([])
  // Override getIssue to return the issue for resume
  taskAdapter.getIssue = async (id) => id === 'issue-1' ? issue : null

  const contextBuilder = createContextBuilder({
    taskAdapter,
    gitAdapter,
  })

  // New orchestrator picks up incomplete state
  const orchestrator = createOrchestrator({
    company,
    taskAdapter,
    gitAdapter,
    llmAdapters: new Map([['anthropic', llmAdapter]]),
    contextBuilder,
    stateStore,
    costTracker: createCostTracker(),
  })

  const timeout = setTimeout(() => orchestrator.stop(), 2000)
  await orchestrator.start()
  clearTimeout(timeout)

  // Should have committed and created PR from saved state
  expect(gitAdapter.commits.length).toBe(1)
  expect(gitAdapter.prs.length).toBe(1)
  expect(taskAdapter.statuses.get('issue-1')).toBe('in_review')
})
