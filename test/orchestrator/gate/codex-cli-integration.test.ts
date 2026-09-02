// Integration test for issue #17: the gate loop (runGatePass), driven with a
// REAL @floor-agents/codex-cli Reviewer instance (not createFakeReviewer),
// exercised end to end via a fixture binary — the same fixture-binary
// approach used in test/codex-cli/adapter.test.ts. This proves the loop
// posts the codex-cli adapter's returned `ReviewResult.text` as the PR
// comment body byte-for-byte (no re-trimming, editing, or re-wrapping
// anywhere in the gate/orchestrator path).
//
// This file constructs the Reviewer directly (via createCodexReviewer), not
// through src/gate.ts's own GATE_REVIEWER/GATE_CODEX_* env-var wiring — that
// wiring (codexReviewerConfigFromEnv / createReviewer, in
// src/gate/create-reviewer.ts) is covered separately by
// test/gate/create-reviewer.test.ts.

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexReviewer } from '@floor-agents/codex-cli'
import type {
  GitAdapter,
  PRDetails,
  PRCommentEntry,
  CheckStatus,
  FileContent,
  FileEntry,
  Commit,
  PullRequest,
} from '@floor-agents/core'
import { runGatePass, createGateStateStore, DEFAULT_GATE_CONFIG, DEFAULT_VENDOR_CONFIG, DEFAULT_CHECKLISTS_CONFIG, type GateModeConfig, type GateStateStore } from '@floor-agents/orchestrator'

// Same fixture directory the codex-cli package's own tests use.
const FIXTURES = join(import.meta.dir, '..', '..', 'codex-cli', 'fixtures')
// Deliberately NOT test/codex-cli/fixtures/ok.ts: that fixture's review body
// is already boundary-clean and single-blank-line-separated, so comparing
// against it byte-for-byte would still pass even if something re-trimmed or
// reformatted result.text before posting — the assertion wouldn't actually
// be exercising anything. This fixture's body carries a two-space indent on
// the line right after the header and extra blank lines after the verdict
// line, so the comparison below is checking real whitespace fidelity, not
// just that some text arrived. See the fixture file's own comment for what
// this can and can't prove given extractReview()'s guarantees.
const VERBATIM_WHITESPACE = join(FIXTURES, 'verbatim-whitespace.ts')

// The exact text test/codex-cli/fixtures/verbatim-whitespace.ts produces
// after the adapter's extractReview() strips the preceding progress log and
// ALL trailing whitespace (see packages/codex-cli/src/extract.ts) — this is
// "the adapter's returned text" the loop must post unchanged. Note the
// two-space indent on the second line is internal, not boundary, whitespace
// — it is NOT touched by extractReview()'s trailing strip, and (unlike
// boundary whitespace) it also would NOT be removed by a stray `.trim()`
// call... except trim() only touches the string's own start/end, and this
// string's start/end are already clean (starts with "#", ends with "s"), so
// there is nothing left for such a call to strip either way. What the
// indent actually protects against is a reformat that touches internal
// content (e.g. a naive "clean up each line" pass) — not a plain
// String.prototype.trim().
const EXPECTED_REVIEW_TEXT =
  '## Reviewer agent (Codex)\n  Reviewed commit abc1234.\n\nVerdict: approve as-is'

function makeFakeGateStateStore(): GateStateStore {
  const store = new Map<string, any>()
  return {
    async get(repo, prNumber) {
      return store.get(`${repo}#${prNumber}`) ?? null
    },
    async save(state) {
      store.set(`${state.repo}#${state.prNumber}`, state)
    },
  }
}

let originPath: string
let clonePath: string
let worktreeRoot: string
let headSha: string

beforeAll(async () => {
  // resolveWorktree() always does `git fetch origin <sha>`, so this needs a
  // real `origin` remote, not just a bare local repo with a commit in it —
  // same setup as test/codex-cli/adapter.test.ts's beforeAll.
  originPath = await mkdtemp(join(tmpdir(), 'gate-codex-integration-origin-'))
  await Bun.$`git -C ${originPath} init -q --bare -b main`.quiet()

  clonePath = await mkdtemp(join(tmpdir(), 'gate-codex-integration-clone-'))
  await Bun.$`git clone -q ${originPath} ${clonePath}`.quiet()
  await Bun.$`git -C ${clonePath} config user.email test@example.com`.quiet()
  await Bun.$`git -C ${clonePath} config user.name test`.quiet()
  await Bun.write(join(clonePath, 'file.txt'), 'hello\n')
  await Bun.$`git -C ${clonePath} add -A`.quiet()
  await Bun.$`git -C ${clonePath} commit -q -m init`.quiet()
  await Bun.$`git -C ${clonePath} push -q origin main`.quiet()
  headSha = (await Bun.$`git -C ${clonePath} rev-parse HEAD`.quiet().text()).trim()

  worktreeRoot = await mkdtemp(join(tmpdir(), 'gate-codex-integration-root-'))
})

afterAll(async () => {
  await rm(clonePath, { recursive: true, force: true }).catch(() => {})
  await rm(originPath, { recursive: true, force: true }).catch(() => {})
  await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
})

function makeGitAdapter(pr: PRDetails, commentCalls: { repo: string; prId: string; body: string }[]): GitAdapter {
  return {
    async getFile(): Promise<FileContent | null> { return null },
    async getTree(): Promise<FileEntry[]> { return [] },
    async createBranch() {},
    async commitFiles(): Promise<string> { return 'sha' },
    async createPR(): Promise<PullRequest> { throw new Error('not used in this test') },
    async getPRDiff() {
      return 'diff --git a/src/thing.ts b/src/thing.ts\n+added a line\n'
    },
    async addPRComment(repo, prId, body) {
      commentCalls.push({ repo, prId, body })
    },
    async mergePR() { throw new Error('not used in this test') },
    async getRecentCommits(): Promise<Commit[]> { return [] },
    async listOpenPRs() { return [pr] },
    async getPR() { return pr },
    async getCheckStatus(): Promise<CheckStatus> { return 'pending' },
    async listComments(): Promise<PRCommentEntry[]> { return [] },
    async addLabel() {},
    async removeLabel() {},
    async getCommitDate() { return new Date('2026-01-01T00:00:00Z') },
  }
}

test('gate loop wired to a real codex-cli Reviewer (fixture binary) posts its ReviewResult.text verbatim', async () => {
  const pr: PRDetails = {
    id: '7',
    url: 'https://github.com/acme/widgets/pull/7',
    title: 'Add a feature',
    body: 'Implements the feature.',
    headSha,
    headRef: 'feat/thing',
    baseRef: 'main',
    authorLogin: 'some-human',
    labels: [],
    draft: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  }

  const commentCalls: { repo: string; prId: string; body: string }[] = []
  const git = makeGitAdapter(pr, commentCalls)

  // The real package's Reviewer — no worktreePath given to review(), so this
  // exercises the same auto-created-worktree path the gate loop always uses
  // (loop.ts calls reviewer.review() without a worktreePath), driven by the
  // `verbatim-whitespace.ts` fixture in place of a real codex binary.
  const reviewer = createCodexReviewer({ binary: VERBATIM_WHITESPACE, clonePath, worktreeRoot })

  const config: GateModeConfig = {
    repos: ['acme/widgets'],
    pollIntervalMs: 60_000,
    promptTemplatePath: 'unused-in-tests.md',
    stateDir: 'unused-in-tests',
    mergeEnabled: false,
    excludeAuthors: [],
    gate: DEFAULT_GATE_CONFIG,
    vendor: DEFAULT_VENDOR_CONFIG,
    checklists: DEFAULT_CHECKLISTS_CONFIG,
  }

  await runGatePass({
    git,
    reviewer,
    gateStateStore: makeFakeGateStateStore(),
    config,
    log: () => {},
    loadPromptTemplate: async () => 'Review {{repo}}#{{prNumber}}\nFiles:\n{{changedFiles}}',
  })

  expect(commentCalls).toHaveLength(1)
  expect(commentCalls[0]!.repo).toBe('acme/widgets')
  expect(commentCalls[0]!.prId).toBe('7')
  // The exact string the codex-cli adapter's review() resolved with, posted
  // with no editing, summarizing, re-wrapping, or re-trimming in between.
  expect(commentCalls[0]!.body).toBe(EXPECTED_REVIEW_TEXT)
})

test('a real createGateStateStore + real codex-cli Reviewer round trip also posts verbatim (broader smoke test)', async () => {
  const pr: PRDetails = {
    id: '9',
    url: 'https://github.com/acme/widgets/pull/9',
    title: 'Add another feature',
    body: 'Implements another feature.',
    headSha,
    headRef: 'feat/other-thing',
    baseRef: 'main',
    authorLogin: 'some-human',
    labels: [],
    draft: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  }

  const commentCalls: { repo: string; prId: string; body: string }[] = []
  const git = makeGitAdapter(pr, commentCalls)
  const reviewer = createCodexReviewer({ binary: VERBATIM_WHITESPACE, clonePath, worktreeRoot })

  const stateDir = await mkdtemp(join(tmpdir(), 'gate-codex-integration-state-'))
  try {
    const config: GateModeConfig = {
      repos: ['acme/widgets'],
      pollIntervalMs: 60_000,
      promptTemplatePath: 'unused-in-tests.md',
      stateDir,
      mergeEnabled: false,
      excludeAuthors: [],
      gate: DEFAULT_GATE_CONFIG,
      vendor: DEFAULT_VENDOR_CONFIG,
      checklists: DEFAULT_CHECKLISTS_CONFIG,
    }

    await runGatePass({
      git,
      reviewer,
      gateStateStore: createGateStateStore(stateDir),
      config,
      log: () => {},
      loadPromptTemplate: async () => 'Review {{repo}}#{{prNumber}}\nFiles:\n{{changedFiles}}',
    })

    expect(commentCalls).toHaveLength(1)
    expect(commentCalls[0]!.body).toBe(EXPECTED_REVIEW_TEXT)
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {})
  }
})
