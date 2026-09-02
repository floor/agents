import { test, expect } from 'bun:test'
import { decideGate, DEFAULT_GATE_CONFIG, type GateDecisionInput, type GateConfig } from '../../../packages/orchestrator/src/gate/decision.ts'

const HEAD_SHA = 'deadbeef00112233445566778899aabbccddeeff'
const HEAD_SHORT = HEAD_SHA.slice(0, 12) // the minimum accepted abbreviation length

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

let nextCommentId = 1

function approveComment(
  vendor: string,
  opts: { sha?: string; createdAt: Date; decision?: string; author?: string; id?: string } = { createdAt: new Date() },
) {
  const decision = opts.decision ?? 'approve as-is'
  const lines = [`## Reviewer agent (${vendor})`, '']
  if (opts.sha) lines.push(`Reviewed at ${opts.sha}.`)
  lines.push(`Verdict: ${decision}`)
  return {
    id: opts.id ?? String(nextCommentId++),
    author: opts.author ?? `${vendor.toLowerCase()}-bot`,
    body: lines.join('\n'),
    createdAt: opts.createdAt,
  }
}

function baseInput(overrides: Partial<GateDecisionInput> = {}): GateDecisionInput {
  return {
    pr: { labels: [], draft: false, headSha: HEAD_SHA, body: 'A normal PR body.' },
    implementerVendor: 'human',
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

test('a valid approve-as-is verdict naming an abbreviated (12-char) head sha still counts', () => {
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { sha: HEAD_SHORT, createdAt: new Date() })],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('a sha shorter than 12 hex chars is never extracted, so it does not count even if it IS a prefix of the head', () => {
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { sha: HEAD_SHA.slice(0, 7), createdAt: new Date() })],
  }))
  expect(result.kind).toBe('needs_review')
})

test('a 12-hex prefix of a DIFFERENT commit does not match the head', () => {
  // Same length as a valid abbreviation, but not a prefix of HEAD_SHA.
  const otherCommitPrefix = 'ffffffffffff'
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { sha: otherCommitPrefix, createdAt: new Date() })],
  }))
  expect(result.kind).toBe('needs_review')
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

test('a verdict naming a different (stale) sha does not count', () => {
  const staleSha = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { sha: staleSha, createdAt: new Date('2026-02-01') })],
  }))
  expect(result.kind).toBe('needs_review')
})

// ── Naming the head sha is mandatory — no date-based fallback ────────────
//
// A verdict that never names a sha at all does not count, no matter when
// it was posted. This closes a real hole: without this rule, a verdict
// posted before a force-push to an OLDER commit could still read as
// "posted after the (old) head's commit date" and incorrectly carry over.

test('a sha-less verdict never counts, however recently it was posted', () => {
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { createdAt: new Date() })], // no `sha` at all
  }))
  expect(result.kind).toBe('needs_review')
})

test('a sha-less verdict does not block either: it simply does not count', () => {
  const result = decideGate(baseInput({
    comments: [approveComment('codex', { createdAt: new Date(), decision: 'changes needed' })],
  }))
  expect(result.kind).toBe('needs_review')
})

test('only the latest valid verdict per vendor counts: a later approval supersedes an earlier "changes needed"', () => {
  const result = decideGate(baseInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-11'), decision: 'changes needed' }),
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-12') }),
    ],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('only the latest valid verdict per vendor counts: a later "changes needed" supersedes an earlier approval', () => {
  const result = decideGate(baseInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-11') }),
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-12'), decision: 'changes needed' }),
    ],
  }))
  expect(result.kind).toBe('blocked')
})

test('a same-second tie between two verdicts from the same vendor is broken by comment id: approve then changes-needed blocks', () => {
  const t = new Date('2026-01-11T00:00:00.000Z')
  const result = decideGate(baseInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: t, id: '100' }),
      approveComment('codex', { sha: HEAD_SHA, createdAt: t, id: '101', decision: 'changes needed' }),
    ],
  }))
  expect(result.kind).toBe('blocked')
})

test('a same-second tie between two verdicts from the same vendor is broken by comment id: changes-needed then approve merges', () => {
  const t = new Date('2026-01-11T00:00:00.000Z')
  const result = decideGate(baseInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: t, id: '100', decision: 'changes needed' }),
      approveComment('codex', { sha: HEAD_SHA, createdAt: t, id: '101' }),
    ],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('the tie-break is by id order, not comment array order', () => {
  const t = new Date('2026-01-11T00:00:00.000Z')
  // The higher-id (later) comment appears FIRST in the array; it must still win.
  const result = decideGate(baseInput({
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: t, id: '101' }),
      approveComment('codex', { sha: HEAD_SHA, createdAt: t, id: '100', decision: 'changes needed' }),
    ],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
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

// ── Multi-vendor trustedReviewers (a single login trusted for more than
// one vendor, e.g. a gate-loop bot account posting both a primary and a
// secondReviewer review) — trustedReviewers[login] can be an array, in
// which case the actual vendor comes from the comment's OWN header text,
// but only when that header names one of the vendors the login is listed
// for. This is the rule a spoofed header must not be able to defeat: an
// array entry is NOT "trust this login for any vendor it claims" — it is
// "trust this login for exactly these vendors, whichever its header says."

test('a login trusted for an array of vendors: the vendor is taken from the header when it is in the allowed list', () => {
  const config: GateConfig = { ...DEFAULT_GATE_CONFIG, trustedReviewers: { 'gate-bot': ['codex', 'gemini'] } }
  const result = decideGate(baseInput({
    config,
    comments: [approveComment('gemini', { sha: HEAD_SHA, createdAt: new Date(), author: 'gate-bot' })],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('a login trusted for an array of vendors: a header naming a vendor OUTSIDE the allowed list is rejected outright, not attributed to any vendor', () => {
  const config: GateConfig = { ...DEFAULT_GATE_CONFIG, trustedReviewers: { 'gate-bot': ['codex', 'gemini'] } }
  const result = decideGate(baseInput({
    config,
    // "grok" is not in gate-bot's allowed list — this must not count as a
    // verdict from "grok" (or from anything else), however well-formed.
    comments: [approveComment('grok', { sha: HEAD_SHA, createdAt: new Date(), author: 'gate-bot' })],
  }))
  expect(result.kind).toBe('needs_review')
})

test('a spoofed header cannot make a multi-vendor login count as a vendor it never actually posted', () => {
  // gate-bot is trusted for codex+gemini. Even a well-formed "changes
  // needed" from a vendor outside that list must not block the gate either
  // — it simply never counts, in either direction.
  const config: GateConfig = { ...DEFAULT_GATE_CONFIG, trustedReviewers: { 'gate-bot': ['codex', 'gemini'] } }
  const result = decideGate(baseInput({
    config,
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-11'), author: 'gate-bot' }),
      approveComment('claude', { sha: HEAD_SHA, createdAt: new Date('2026-01-12'), author: 'gate-bot', decision: 'changes needed' }),
    ],
  }))
  expect(result).toEqual({ kind: 'mergeable' }) // the "claude" comment never counted at all
})

test('auth gate: a single multi-vendor login can supply BOTH required distinct-vendor approvals via its header', () => {
  const config: GateConfig = { ...DEFAULT_GATE_CONFIG, trustedReviewers: { 'gate-bot': ['codex', 'gemini'] } }
  const result = decideGate(authInput({
    config,
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-11'), author: 'gate-bot' }),
      approveComment('gemini', { sha: HEAD_SHA, createdAt: new Date('2026-01-12'), author: 'gate-bot' }),
    ],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('auth gate: a multi-vendor login posting the SAME header vendor twice still only counts as one vendor', () => {
  const config: GateConfig = { ...DEFAULT_GATE_CONFIG, trustedReviewers: { 'gate-bot': ['codex', 'gemini'] } }
  const result = decideGate(authInput({
    config,
    comments: [
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-11'), author: 'gate-bot' }),
      approveComment('codex', { sha: HEAD_SHA, createdAt: new Date('2026-01-12'), author: 'gate-bot' }),
    ],
  }))
  expect(result.kind).toBe('blocked')
})

test('a single-string trustedReviewers value ignores the header entirely, even for an unrelated vendor name', () => {
  // Unlike the array form, a plain string value is unconditional — this
  // pins that widening trustedReviewers to allow arrays did not change the
  // existing single-vendor string behavior.
  const config: GateConfig = { ...DEFAULT_GATE_CONFIG, trustedReviewers: { 'codex-bot': 'codex' } }
  const result = decideGate(baseInput({
    config,
    comments: [approveComment('some-other-vendor-name', { sha: HEAD_SHA, createdAt: new Date(), author: 'codex-bot' })],
  }))
  expect(result).toEqual({ kind: 'mergeable' })
})

test('an empty array value trusts the login for nothing — every comment from it is rejected', () => {
  const config: GateConfig = { ...DEFAULT_GATE_CONFIG, trustedReviewers: { 'gate-bot': [] } }
  const result = decideGate(baseInput({
    config,
    comments: [approveComment('codex', { sha: HEAD_SHA, createdAt: new Date(), author: 'gate-bot' })],
  }))
  expect(result.kind).toBe('needs_review')
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
