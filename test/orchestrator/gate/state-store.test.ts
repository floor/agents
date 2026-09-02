import { test, expect, beforeEach, afterEach } from 'bun:test'
import { createGateStateStore } from '@floor-agents/orchestrator'
import { mkdir, rm } from 'node:fs/promises'
import type { GatePrState } from '@floor-agents/orchestrator'

const TEST_DIR = './data/test-gate-state'

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

function makeState(overrides: Partial<GatePrState> = {}): GatePrState {
  return {
    repo: 'acme/widgets',
    prNumber: '42',
    headSha: 'a'.repeat(40),
    decisionKind: 'needs_review',
    reason: 'no valid approve-as-is verdict yet',
    merged: false,
    reviewedHeads: {},
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

test('returns null for a PR with no persisted state', async () => {
  const store = createGateStateStore(TEST_DIR)
  expect(await store.get('acme/widgets', '1')).toBeNull()
})

test('saves and retrieves state, keyed by repo + PR number', async () => {
  const store = createGateStateStore(TEST_DIR)
  await store.save(makeState())

  const loaded = await store.get('acme/widgets', '42')
  expect(loaded).not.toBeNull()
  expect(loaded!.headSha).toBe('a'.repeat(40))
  expect(loaded!.decisionKind).toBe('needs_review')
})

test('a repo containing a slash does not collide with a different repo of the same PR number', async () => {
  const store = createGateStateStore(TEST_DIR)
  await store.save(makeState({ repo: 'acme/widgets', prNumber: '1', decisionKind: 'mergeable' }))
  await store.save(makeState({ repo: 'floor/agents', prNumber: '1', decisionKind: 'blocked' }))

  expect((await store.get('acme/widgets', '1'))!.decisionKind).toBe('mergeable')
  expect((await store.get('floor/agents', '1'))!.decisionKind).toBe('blocked')
})

test('overwrites existing state for the same repo + PR', async () => {
  const store = createGateStateStore(TEST_DIR)
  await store.save(makeState({ decisionKind: 'needs_review', headSha: 'a'.repeat(40) }))
  await store.save(makeState({ decisionKind: 'mergeable', headSha: 'b'.repeat(40), merged: true }))

  const loaded = await store.get('acme/widgets', '42')
  expect(loaded!.decisionKind).toBe('mergeable')
  expect(loaded!.headSha).toBe('b'.repeat(40))
  expect(loaded!.merged).toBe(true)
})

test('persists and retrieves reviewedHeads', async () => {
  const store = createGateStateStore(TEST_DIR)
  await store.save(makeState({ reviewedHeads: { [`${'a'.repeat(40)}`]: ['codex', 'gemini'] } }))

  const loaded = await store.get('acme/widgets', '42')
  expect(loaded!.reviewedHeads).toEqual({ [`${'a'.repeat(40)}`]: ['codex', 'gemini'] })
})

test('returns null and logs rather than throwing on a corrupt state file', async () => {
  await Bun.write(`${TEST_DIR}/acme__widgets__42.json`, 'not valid json{{{')
  const store = createGateStateStore(TEST_DIR)
  expect(await store.get('acme/widgets', '42')).toBeNull()
})
