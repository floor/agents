import { test, expect } from 'bun:test'
import { createFakeReviewer } from '@floor-agents/core'
import {
  antigravityReviewerConfigFromEnv,
  codexReviewerConfigFromEnv,
  createReviewer,
  createReviewerForKind,
} from '../../src/gate/create-reviewer.ts'

// These exercise src/gate.ts's own env-var -> Reviewer construction path
// directly, complementing test/orchestrator/gate/codex-cli-integration.test.ts
// (which proves the loop posts a real codex-cli Reviewer's output verbatim,
// but constructs that Reviewer itself rather than going through this
// env-var mapping).

test('codexReviewerConfigFromEnv returns an empty config when no GATE_CODEX_* vars are set', () => {
  expect(codexReviewerConfigFromEnv({})).toEqual({})
})

test('codexReviewerConfigFromEnv maps every GATE_CODEX_* var to its CodexReviewerConfig key one-to-one', () => {
  const config = codexReviewerConfigFromEnv({
    GATE_CODEX_BINARY: '/usr/local/bin/codex',
    GATE_CODEX_MODEL: 'gpt-5.1-codex',
    GATE_CODEX_PROFILE: 'ci-reviewer',
    GATE_CODEX_CLONE_PATH: '/var/floor-agents/clone',
    GATE_CODEX_WORKTREE_ROOT: '/var/floor-agents/worktrees',
    GATE_CODEX_TIMEOUT_MS: '900000',
  })

  expect(config).toEqual({
    binary: '/usr/local/bin/codex',
    model: 'gpt-5.1-codex',
    profile: 'ci-reviewer',
    clonePath: '/var/floor-agents/clone',
    worktreeRoot: '/var/floor-agents/worktrees',
    timeoutMs: 900_000,
  })
})

test('codexReviewerConfigFromEnv omits a key entirely when its env var is unset, rather than passing undefined', () => {
  const config = codexReviewerConfigFromEnv({ GATE_CODEX_MODEL: 'gpt-5.1-codex' })

  expect(Object.keys(config)).toEqual(['model'])
})

test('codexReviewerConfigFromEnv: GATE_CODEX_TIMEOUT_MS accepts a plain positive integer', () => {
  expect(codexReviewerConfigFromEnv({ GATE_CODEX_TIMEOUT_MS: '1' }).timeoutMs).toBe(1)
  expect(codexReviewerConfigFromEnv({ GATE_CODEX_TIMEOUT_MS: '600000' }).timeoutMs).toBe(600_000)
})

test('codexReviewerConfigFromEnv: GATE_CODEX_TIMEOUT_MS rejects anything that is not a plain decimal integer string', () => {
  const rejects = ['0', '-1', '-5', '0.5', '1e3', '0x10', '', ' ', '5ms', '5 ', ' 5', 'NaN', 'Infinity']
  for (const raw of rejects) {
    expect(() => codexReviewerConfigFromEnv({ GATE_CODEX_TIMEOUT_MS: raw })).toThrow(/GATE_CODEX_TIMEOUT_MS/)
  }
})

test('createReviewer defaults to "codex" when GATE_REVIEWER is unset', () => {
  // No clonePath/worktreePath given here, so constructing this reviewer must
  // not itself require a review() call to succeed — createCodexReviewer()
  // only validates its own config at construction time.
  const reviewer = createReviewer({})
  expect(reviewer.vendor).toBe('codex')
})

test('createReviewer returns a fake reviewer for GATE_REVIEWER=fake, with vendor "fake"', () => {
  const reviewer = createReviewer({ GATE_REVIEWER: 'fake' })
  expect(reviewer.vendor).toBe('fake')

  // Sanity: matches what createFakeReviewer({ vendor: 'fake' }) would produce.
  const expected = createFakeReviewer({ vendor: 'fake' })
  expect(reviewer.vendor).toBe(expected.vendor)
})

test('createReviewer throws a clear error for an unknown GATE_REVIEWER value', () => {
  expect(() => createReviewer({ GATE_REVIEWER: 'some-unknown-vendor' })).toThrow(/some-unknown-vendor/)
})

test('createReviewer("codex") threads GATE_CODEX_MODEL/PROFILE validation errors through, proving it is not silently swallowed', () => {
  // codex-cli's own charset validation must still fire when reached through
  // this wiring, not just when calling createCodexReviewer() directly.
  expect(() => createReviewer({ GATE_CODEX_MODEL: '--not-a-real-model' })).toThrow(/model/i)
  expect(() => createReviewer({ GATE_CODEX_PROFILE: 'has spaces' })).toThrow(/profile/i)
})

// ── GATE_REVIEWER=gemini / @floor-agents/antigravity-cli wiring ─────────

test('antigravityReviewerConfigFromEnv returns an empty config when no GATE_AGY_* vars are set', () => {
  expect(antigravityReviewerConfigFromEnv({})).toEqual({})
})

test('antigravityReviewerConfigFromEnv maps every GATE_AGY_* var to its AntigravityReviewerConfig key one-to-one', () => {
  const config = antigravityReviewerConfigFromEnv({
    GATE_AGY_BINARY: '/usr/local/bin/agy',
    GATE_AGY_MODEL: 'gemini-3.8-flash-high',
    GATE_AGY_EFFORT: 'high',
    GATE_AGY_CLONE_PATH: '/var/floor-agents/clone',
    GATE_AGY_WORKTREE_ROOT: '/var/floor-agents/worktrees',
    GATE_AGY_SETTINGS_PATH: '/var/floor-agents/agy-settings.json',
    GATE_AGY_TIMEOUT_MS: '900000',
  })

  expect(config).toEqual({
    binary: '/usr/local/bin/agy',
    model: 'gemini-3.8-flash-high',
    effort: 'high',
    clonePath: '/var/floor-agents/clone',
    worktreeRoot: '/var/floor-agents/worktrees',
    settingsPath: '/var/floor-agents/agy-settings.json',
    timeoutMs: 900_000,
  })
})

test('antigravityReviewerConfigFromEnv omits a key entirely when its env var is unset, rather than passing undefined', () => {
  const config = antigravityReviewerConfigFromEnv({ GATE_AGY_MODEL: 'gemini-3.8-flash-high' })
  expect(Object.keys(config)).toEqual(['model'])
})

test('antigravityReviewerConfigFromEnv: GATE_AGY_TIMEOUT_MS rejects anything that is not a plain decimal integer string', () => {
  const rejects = ['0', '-1', '0.5', '1e3', '5ms']
  for (const raw of rejects) {
    expect(() => antigravityReviewerConfigFromEnv({ GATE_AGY_TIMEOUT_MS: raw })).toThrow(/GATE_AGY_TIMEOUT_MS/)
  }
})

test('createReviewer returns the antigravity-cli reviewer for GATE_REVIEWER=gemini, with vendor "gemini"', () => {
  const reviewer = createReviewer({ GATE_REVIEWER: 'gemini' })
  expect(reviewer.vendor).toBe('gemini')
})

test('createReviewer("gemini") threads GATE_AGY_MODEL validation errors through, proving it is not silently swallowed', () => {
  expect(() => createReviewer({ GATE_REVIEWER: 'gemini', GATE_AGY_MODEL: 'has spaces' })).toThrow(/model/i)
  expect(() => createReviewer({ GATE_REVIEWER: 'gemini', GATE_AGY_EFFORT: 'extreme' })).toThrow(/effort/i)
})

// ── createReviewerForKind (used directly for the second reviewer) ───────

test('createReviewerForKind builds each supported vendor kind regardless of GATE_REVIEWER', () => {
  expect(createReviewerForKind('codex', {}).vendor).toBe('codex')
  expect(createReviewerForKind('gemini', {}).vendor).toBe('gemini')
  expect(createReviewerForKind('fake', {}).vendor).toBe('fake')
})

test('createReviewerForKind throws a clear error for an unknown kind, the same as createReviewer does for GATE_REVIEWER', () => {
  expect(() => createReviewerForKind('some-unknown-vendor', {})).toThrow(/some-unknown-vendor/)
})
