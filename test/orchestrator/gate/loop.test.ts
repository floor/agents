import { test, expect } from 'bun:test'
import { createFakeReviewer } from '@floor-agents/core'
import type { GitAdapter, PRDetails, PRCommentEntry, CheckStatus, FileContent, FileEntry, Commit, PullRequest } from '@floor-agents/core'
import {
  runGatePass,
  createGateStateStore,
  DEFAULT_GATE_CONFIG,
  DEFAULT_VENDOR_CONFIG,
  type GateModeConfig,
  type GateStateStore,
} from '@floor-agents/orchestrator'

// ── In-memory fake GateStateStore (loop tests don't need real disk I/O) ──

function makeFakeGateStateStore(): GateStateStore {
  const store = new Map<string, any>()
  const key = (repo: string, prNumber: string) => `${repo}#${prNumber}`
  return {
    async get(repo, prNumber) {
      return store.get(key(repo, prNumber)) ?? null
    },
    async save(state) {
      store.set(key(state.repo, state.prNumber), state)
    },
  }
}

// ── In-memory fake GitAdapter ─────────────────────────────────────────────

type FakePR = { -readonly [K in keyof PRDetails]: PRDetails[K] } & {
  comments: PRCommentEntry[]
  checkStatus: CheckStatus
  commitDate: Date
  merged?: boolean
}

function makeFakeGitAdapter(prs: FakePR[]) {
  const mergeCalls: { repo: string; prId: string; options?: any }[] = []
  const commentCalls: { repo: string; prId: string; body: string }[] = []

  const adapter: GitAdapter = {
    async getFile(): Promise<FileContent | null> { return null },
    async getTree(): Promise<FileEntry[]> { return [] },
    async createBranch() {},
    async commitFiles(): Promise<string> { return 'sha' },
    async createPR(): Promise<PullRequest> {
      throw new Error('not used in gate loop tests')
    },
    async getPRDiff(_repo, prId) {
      return `diff --git a/src/thing.ts b/src/thing.ts\n+added line for PR ${prId}\n`
    },
    async addPRComment(repo, prId, body) {
      commentCalls.push({ repo, prId, body })
      const pr = prs.find(p => p.id === prId)
      if (pr) pr.comments.push({ id: String(pr.comments.length + 1), author: 'reviewer-bot', body, createdAt: new Date() })
    },
    async mergePR(repo, prId, options) {
      mergeCalls.push({ repo, prId, options })
      const pr = prs.find(p => p.id === prId)
      if (pr) pr.merged = true
    },
    async getRecentCommits(): Promise<Commit[]> { return [] },
    async listOpenPRs(repo) {
      return prs.filter(p => !p.merged)
    },
    async getPR(_repo, prId) {
      return prs.find(p => p.id === prId) ?? null
    },
    async getCheckStatus(_repo, sha) {
      return prs.find(p => p.headSha === sha)?.checkStatus ?? 'pending'
    },
    async listComments(_repo, prId) {
      return prs.find(p => p.id === prId)?.comments ?? []
    },
    async addLabel(_repo, prId, label) {
      const pr = prs.find(p => p.id === prId)
      if (pr && !pr.labels.includes(label)) (pr.labels as string[]).push(label)
    },
    async removeLabel(_repo, prId, label) {
      const pr = prs.find(p => p.id === prId)
      if (pr) (pr as any).labels = pr.labels.filter(l => l !== label)
    },
    async getCommitDate(_repo, sha) {
      return prs.find(p => p.headSha === sha)?.commitDate ?? new Date(0)
    },
  }

  return { adapter, mergeCalls, commentCalls }
}

function makePR(overrides: Partial<FakePR> = {}): FakePR {
  return {
    id: '1',
    url: 'https://github.com/acme/widgets/pull/1',
    title: 'Add a feature',
    body: 'Implements the feature.\n\nSecond paragraph.',
    headSha: 'a'.repeat(40),
    headRef: 'feat/thing',
    baseRef: 'main',
    authorLogin: 'implementer-bot',
    labels: [],
    draft: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    comments: [],
    checkStatus: 'success',
    commitDate: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function makeConfig(overrides: Partial<GateModeConfig> = {}): GateModeConfig {
  return {
    repos: ['acme/widgets'],
    pollIntervalMs: 60_000,
    promptTemplatePath: 'unused-in-tests.md',
    stateDir: 'unused-in-tests',
    mergeEnabled: false,
    gate: DEFAULT_GATE_CONFIG,
    vendor: DEFAULT_VENDOR_CONFIG,
    ...overrides,
  }
}

const NOOP_LOG = () => {}

test('needs_review: calls the reviewer once and posts its text verbatim', async () => {
  const pr = makePR()
  const { adapter, commentCalls } = makeFakeGitAdapter([pr])
  const reviewer = createFakeReviewer({ vendor: 'codex', text: '## Reviewer agent (Codex)\n\nVerdict: approve as-is' })

  await runGatePass({
    git: adapter,
    reviewer,
    gateStateStore: makeFakeGateStateStore(),
    config: makeConfig(),
    log: NOOP_LOG,
    loadPromptTemplate: async () => 'Review {{repo}}#{{prNumber}}\nFiles:\n{{changedFiles}}',
  })

  expect(commentCalls.length).toBe(1)
  expect(commentCalls[0]!.body).toBe('## Reviewer agent (Codex)\n\nVerdict: approve as-is')
})

test('does not re-review the same head on a second pass', async () => {
  const pr = makePR()
  const { adapter, commentCalls } = makeFakeGitAdapter([pr])
  const reviewer = createFakeReviewer({ vendor: 'codex' })
  const deps = {
    git: adapter,
    reviewer,
    gateStateStore: makeFakeGateStateStore(),
    config: makeConfig(),
    log: NOOP_LOG,
    loadPromptTemplate: async () => 'template',
  }

  await runGatePass(deps)
  expect(commentCalls.length).toBe(1)

  await runGatePass(deps)
  expect(commentCalls.length).toBe(1) // still 1 — the posted verdict comment is now on the head
})

test('a fresh push (new head) after a review triggers a new review', async () => {
  const pr = makePR()
  const { adapter, commentCalls } = makeFakeGitAdapter([pr])
  const reviewer = createFakeReviewer({ vendor: 'codex' })
  const deps = {
    git: adapter,
    reviewer,
    gateStateStore: makeFakeGateStateStore(),
    config: makeConfig(),
    log: NOOP_LOG,
    loadPromptTemplate: async () => 'template',
  }

  await runGatePass(deps)
  expect(commentCalls.length).toBe(1)

  // Simulate a push: new head sha, dated after the round-1 review comment
  // (which used no sha), so that stale review does not "cover" the new head.
  pr.headSha = 'b'.repeat(40)
  pr.commitDate = new Date(Date.now() + 3_600_000)

  await runGatePass(deps)
  expect(commentCalls.length).toBe(2)
})

test('respects needs-human: no review is posted and no merge is attempted', async () => {
  const pr = makePR({ labels: ['needs-human'] })
  const { adapter, commentCalls, mergeCalls } = makeFakeGitAdapter([pr])
  const reviewer = createFakeReviewer({ vendor: 'codex' })

  await runGatePass({
    git: adapter,
    reviewer,
    gateStateStore: makeFakeGateStateStore(),
    config: makeConfig({ mergeEnabled: true }),
    log: NOOP_LOG,
  })

  expect(commentCalls.length).toBe(0)
  expect(mergeCalls.length).toBe(0)
})

test('dry run (default) never calls mergePR, even when mergeable', async () => {
  const pr = makePR({
    comments: [{ id: 'c1', author: 'codex-bot', body: '## Reviewer agent (Codex)\n\nVerdict: approve as-is', createdAt: new Date('2026-01-02') }],
  })
  const { adapter, mergeCalls } = makeFakeGitAdapter([pr])
  const reviewer = createFakeReviewer({ vendor: 'codex' })

  await runGatePass({
    git: adapter,
    reviewer,
    gateStateStore: makeFakeGateStateStore(),
    config: makeConfig({ mergeEnabled: false }),
    log: NOOP_LOG,
  })

  expect(mergeCalls.length).toBe(0)
})

test('enabled mode calls mergePR exactly once, even across repeated passes', async () => {
  const pr = makePR({
    comments: [{ id: 'c1', author: 'codex-bot', body: '## Reviewer agent (Codex)\n\nVerdict: approve as-is', createdAt: new Date('2026-01-02') }],
  })
  const { adapter, mergeCalls } = makeFakeGitAdapter([pr])
  const reviewer = createFakeReviewer({ vendor: 'codex' })
  const deps = {
    git: adapter,
    reviewer,
    gateStateStore: makeFakeGateStateStore(),
    config: makeConfig({ mergeEnabled: true }),
    log: NOOP_LOG,
  }

  await runGatePass(deps)
  expect(mergeCalls.length).toBe(1)
  expect(mergeCalls[0]!.options).toEqual({
    commitTitle: 'Add a feature (#1)',
    commitMessage: 'Implements the feature.',
  })

  // Second pass: the fake adapter's listOpenPRs already excludes merged PRs,
  // but even if a stale PR list came back, the persisted `merged` flag guards it.
  await runGatePass(deps)
  expect(mergeCalls.length).toBe(1)
})

test('skips calling the reviewer when its vendor matches the implementer vendor', async () => {
  const pr = makePR({ headRef: 'cursor/add-thing' }) // DEFAULT_VENDOR_CONFIG maps cursor/ -> grok
  const { adapter, commentCalls } = makeFakeGitAdapter([pr])
  const reviewer = createFakeReviewer({ vendor: 'grok' })

  await runGatePass({
    git: adapter,
    reviewer,
    gateStateStore: makeFakeGateStateStore(),
    config: makeConfig(),
    log: NOOP_LOG,
  })

  expect(commentCalls.length).toBe(0)
})

test('blocked PRs get no comment and no merge attempt', async () => {
  const pr = makePR({
    comments: [{ id: 'c1', author: 'codex-bot', body: '## Reviewer agent (Codex)\n\nVerdict: changes needed', createdAt: new Date('2026-01-02') }],
  })
  const { adapter, commentCalls, mergeCalls } = makeFakeGitAdapter([pr])
  const reviewer = createFakeReviewer({ vendor: 'codex' })

  await runGatePass({
    git: adapter,
    reviewer,
    gateStateStore: makeFakeGateStateStore(),
    config: makeConfig({ mergeEnabled: true }),
    log: NOOP_LOG,
  })

  expect(commentCalls.length).toBe(0)
  expect(mergeCalls.length).toBe(0)
})

test('persists gate state per PR across a pass', async () => {
  const pr = makePR()
  const { adapter } = makeFakeGitAdapter([pr])
  const reviewer = createFakeReviewer({ vendor: 'codex' })
  const gateStateStore = makeFakeGateStateStore()

  await runGatePass({
    git: adapter,
    reviewer,
    gateStateStore,
    config: makeConfig(),
    log: NOOP_LOG,
    loadPromptTemplate: async () => 'template',
  })

  const state = await gateStateStore.get('acme/widgets', '1')
  expect(state).not.toBeNull()
  expect(state!.headSha).toBe(pr.headSha)
  expect(state!.decisionKind).toBe('needs_review')
})

test('real createGateStateStore integrates with the loop (smoke test)', async () => {
  const { mkdir, rm } = await import('node:fs/promises')
  const dir = './data/test-gate-loop-smoke'
  await mkdir(dir, { recursive: true })
  try {
    const pr = makePR()
    const { adapter, commentCalls } = makeFakeGitAdapter([pr])
    const reviewer = createFakeReviewer({ vendor: 'codex' })

    await runGatePass({
      git: adapter,
      reviewer,
      gateStateStore: createGateStateStore(dir),
      config: makeConfig(),
      log: NOOP_LOG,
      loadPromptTemplate: async () => 'template',
    })

    expect(commentCalls.length).toBe(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
