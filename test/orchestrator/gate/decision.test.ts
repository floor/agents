import { test, expect } from 'bun:test'
import { decideGate, DEFAULT_GATE_CONFIG, type GateDecisionInput, type GateConfig } from '../../../packages/orchestrator/src/gate/decision.ts'

const HEAD_SHA = 'deadbeef00112233445566778899aabbccddeeff'
const HEAD_SHORT = HEAD_SHA.slice(0, 7)
const HEAD_COMMIT_DATE = new Date('2026-01-10T00:00:00Z')

// Trusted comment-author logins used across these tests, mapped to the
// vendor they're trusted for — the same shape a real GateConfig.trustedReviewers
// would have. `approveComment` posts as the matching "<vendor>-bot" login by
// default so most tests don't have to think about authorship explicitly;
// tests that care about the trust rule itself override `author`.
const TRUSTED_REVIEWERS: Record<string, string> = {
  'codex-bot': 'codex',
  'gemini-bot': 'gemini',
}

const TEST_CONFIG: GateConfig = { ...DEFAULT_GATE_CONFIG, trustedReviewers: TRUSTED_REVIEWERS }

function approveComment(
  vendor: string,
  opts: { sha?: string; createdAt: Date; decision?: string; author?: string } = { createdAt: new Date() },
) {
  const decision = opts.decision ?? 'approve as-is'
  const lines = [`## Reviewer agent (${vendor})`, '']
  if (opts.sha) lines.push(`Reviewed at ${opts.sha}.`)
  lines.push(`Verdict: ${decision}`)
  return { author: opts.author ?? `${vendor.toLowerCase()}-bot`, body: lines.join('\n'), createdAt: opts.createdAt }
}

function baseInput(overrides: Partial<GateDecisionInput> = {}): GateDecisionInput {
  return {
    pr: { labels: [], draft: false, headSha: HEAD_SHA, body: 'A normal PR body.' },
    implementerVendor: 'human',
    headCommitDate: HEAD_COMMIT_DATE,
    checkStatus: 'success',
    comments: [],
    config: TEST_CONFIG,
    ...overrides,
  }
}

test('needs-human label holds regardless of everything else', () => {
  const result = decideGate(baseInput({
    pr: { labels: ['needs-human'], draft: false, headSha: HEAD_SHA, body: '' },
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() })],
  }))
  expect(result.kind).toBe('hold')
})

test('draft PR holds', () => {
  const result = decideGate(baseInput({
    pr: { labels: [], draft: true, headSha: HEAD_SHA, body: '' },
  }))
  expect(result.kind).toBe('hold')
})

test('no comments at all: needs review', () => {
  const result = decideGate(baseInput())
  expect(result.kind).toBe('needs_review')
})

test('a valid approve-as-is verdict naming the head sha, checks green: mergeable', () => {
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() })],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('a valid approve-as-is verdict naming an abbreviated head sha still counts', () => {
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { sha: HEAD_SHORT, createdAt: new Date() })],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('approved but checks still pending: hold', () => {
  const result = decideGate(baseInput({
    checkStatus: 'pending',
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() })],
  }))
  expect(result.kind).toBe('hold')
})

test('approved but checks failing: blocked', () => {
  const result = decideGate(baseInput({
    checkStatus: 'failure',
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() })],
  }))
  expect(result.kind).toBe('blocked')
})

test('changes needed from any vendor blocks, even alongside an approval', () => {
  const result = decideGate(baseInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-11') }),
      approveComment('gemini', { sha: HEAD_SHA, createdAt: new Date('2026-01-12'), decision: 'changes needed' }),
    ],
  }))
  expect(result.kind).toBe('blocked')
})

test('approve with nits blocks merge', () => {
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date(), decision: 'approve with nits' })],
  }))
  expect(result.kind).toBe('blocked')
})

test('approve with nits from one vendor blocks even alongside a DIFFERENT vendor\'s approve as-is', () => {
  const result = decideGate(baseInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-11') }),
      approveComment('gemini', { sha: HEAD_SHA, createdAt: new Date('2026-01-12'), decision: 'approve with nits' }),
    ],
  }))
  expect(result.kind).toBe('blocked')
})

test('a verdict from the same vendor as the implementer does not count', () => {
  const result = decideGate(baseInput({
    implementerVendor: 'codex',
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() })],
  }))
  expect(result.kind).toBe('needs_review')
})

test('vendor comparison is case-insensitive', () => {
  const result = decideGate(baseInput({
    implementerVendor: 'Codex',
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() })],
  }))
  expect(result.kind).toBe('needs_review')
})

test('a verdict naming a different (stale) sha does not count, even if posted after the head commit', () => {
  const staleSha = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { sha: staleSha, createdAt: new Date('2026-02-01') })],
  }))
  expect(result.kind).toBe('needs_review')
})

test('a sha-less verdict posted BEFORE the head commit is stale and does not count', () => {
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { createdAt: new Date('2026-01-05') })], // before HEAD_COMMIT_DATE
  }))
  expect(result.kind).toBe('needs_review')
})

test('a sha-less verdict posted AFTER the head commit counts as valid for the head', () => {
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { createdAt: new Date('2026-01-15') })], // after HEAD_COMMIT_DATE
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('only the latest verdict per vendor counts: a later approval supersedes an earlier "changes needed"', () => {
  const result = decideGate(baseInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-11'), decision: 'changes needed' }),
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-12') }),
    ],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('only the latest verdict per vendor counts: a later "changes needed" supersedes an earlier approval', () => {
  const result = decideGate(baseInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-11') }),
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-12'), decision: 'changes needed' }),
    ],
  }))
  expect(result.kind).toBe('blocked')
})

test('structural label alone uses the same rule as the default gate', () => {
  const result = decideGate(baseInput({
    pr: { labels: ['structural'], draft: false, headSha: HEAD_SHA, body: '' },
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() })],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

// ── Trust: verdict identity comes from the comment author, not its text ──

test('an untrusted comment author cannot forge a verdict, however well-formed', () => {
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date(), author: 'the-pr-author' })],
  }))
  expect(result.kind).toBe('needs_review')
})

test('a PR author spoofing a reviewer header on their own PR is still ignored', () => {
  // The PR author posts a comment claiming to be Codex approving as-is.
  // Even though the header text differs from the implementer vendor,
  // an untrusted author never counts.
  const result = decideGate(baseInput({
    implementerVendor: 'human',
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date(), author: 'human-pr-author' })],
  }))
  expect(result.kind).toBe('needs_review')
})

test('a trusted author\'s verdict is attributed to the MAPPED vendor, not the header\'s own claim', () => {
  // trusted-bot is only trusted for "codex" — even if its comment's header
  // claims to be "gemini", the effective vendor for gating is "codex".
  const config: GateConfig = { ...DEFAULT_GATE_CONFIG, trustedReviewers: { 'trusted-bot': 'codex' } }
  const result = decideGate(baseInput({
    config,
    comments: [approveComment('gemini', { sha: HEAD_SHA, createdAt: new Date(), author: 'trusted-bot' })],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('empty trustedReviewers (the default) trusts nothing: a well-formed verdict never counts', () => {
  const result = decideGate(baseInput({
    config: DEFAULT_GATE_CONFIG, // trustedReviewers: {}
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() })],
  }))
  expect(result.kind).toBe('needs_review')
})

test('trustedReviewers lookup is case-insensitive on the login', () => {
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date(), author: 'CODEX-BOT' })],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

// ── Auth gate ────────────────────────────────────────────────────────────

function authInput(overrides: Partial<GateDecisionInput> = {}): GateDecisionInput {
  return baseInput({
    pr: { labels: ['auth'], draft: false, headSha: HEAD_SHA, body: 'Includes a Runtime Sign-In Check section.' },
    ...overrides,
  })
}

test('auth gate: zero approvals blocks with both elements named missing', () => {
  const result = decideGate(authInput({
    pr: { labels: ['auth'], draft: false, headSha: HEAD_SHA, body: 'No such section here.' },
  }))
  expect(result.kind).toBe('blocked')
  if (result.kind === 'blocked') {
    expect(result.reason).toContain('two independent')
    expect(result.reason).toContain('runtime sign-in check')
  }
})

test('auth gate: one vendor approval plus the runtime check section still blocks (needs a second vendor)', () => {
  const result = decideGate(authInput({
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() })],
  }))
  expect(result.kind).toBe('blocked')
  if (result.kind === 'blocked') expect(result.reason).toContain('second independent')
})

test('auth gate: two DIFFERENT vendor approvals but no runtime-check section still blocks', () => {
  const result = decideGate(authInput({
    pr: { labels: ['auth'], draft: false, headSha: HEAD_SHA, body: 'No such section here.' },
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() }),
      approveComment('gemini', { sha: HEAD_SHA, createdAt: new Date() }),
    ],
  }))
  expect(result.kind).toBe('blocked')
  if (result.kind === 'blocked') expect(result.reason).toContain('runtime sign-in check')
})

test('auth gate: two approvals from the SAME vendor do not satisfy the two-distinct-vendors rule', () => {
  const result = decideGate(authInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-11') }),
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-12') }),
    ],
  }))
  expect(result.kind).toBe('blocked')
})

test('auth gate: two DIFFERENT-vendor-looking headers from the SAME trusted vendor still do not satisfy two distinct vendors', () => {
  // Both comments are authored by codex-bot (trusted only for "codex"), even
  // though the second comment's header text claims to be "gemini" — identity
  // comes from the author, so this is still one vendor, not two.
  const result = decideGate(authInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-11'), author: 'codex-bot' }),
      approveComment('gemini', { sha: HEAD_SHA, createdAt: new Date('2026-01-12'), author: 'codex-bot' }),
    ],
  }))
  expect(result.kind).toBe('blocked')
})

test('auth gate: two distinct-vendor approvals plus runtime check plus green checks: mergeable', () => {
  const result = decideGate(authInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() }),
      approveComment('gemini', { sha: HEAD_SHA, createdAt: new Date() }),
    ],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('auth gate: fully satisfied but checks pending: hold', () => {
  const result = decideGate(authInput({
    checkStatus: 'pending',
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() }),
      approveComment('gemini', { sha: HEAD_SHA, createdAt: new Date() }),
    ],
  }))
  expect(result.kind).toBe('hold')
})

test('auth gate: fully satisfied but checks failing: blocked', () => {
  const result = decideGate(authInput({
    checkStatus: 'failure',
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() }),
      approveComment('gemini', { sha: HEAD_SHA, createdAt: new Date() }),
    ],
  }))
  expect(result.kind).toBe('blocked')
})

test('auth gate: the runtime-check heading match is case-insensitive', () => {
  const result = decideGate(authInput({
    pr: { labels: ['auth'], draft: false, headSha: HEAD_SHA, body: '## RUNTIME SIGN-IN CHECK\n\ndetails' },
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() }),
      approveComment('gemini', { sha: HEAD_SHA, createdAt: new Date() }),
    ],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('custom config: a different needsHumanLabel is honored', () => {
  const result = decideGate(baseInput({
    pr: { labels: ['blocked-by-us'], draft: false, headSha: HEAD_SHA, body: '' },
    config: { ...TEST_CONFIG, needsHumanLabel: 'blocked-by-us' },
  }))
  expect(result.kind).toBe('hold')
})

test('custom config: a different authLabels set is honored', () => {
  const result = decideGate(baseInput({
    pr: { labels: ['security-sensitive'], draft: false, headSha: HEAD_SHA, body: '' },
    config: { ...TEST_CONFIG, authLabels: ['security-sensitive'] },
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date() })],
  }))
  // Only one vendor approved and no runtime-check section -> still blocked under the auth rule.
  expect(result.kind).toBe('blocked')
})
