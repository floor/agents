import { test, expect, beforeEach, afterEach } from 'bun:test'
import { createStateStore } from '@floor-agents/orchestrator'
import { mkdir, rm } from 'node:fs/promises'
import type { ExecutionState } from '@floor-agents/core'

const TEST_DIR = './data/test-executions'

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

function makeState(issueId: string, step: ExecutionState['step'] = 'pending'): ExecutionState {
  return {
    issueId,
    agentId: 'backend',
    step,
    startedAt: new Date().toISOString(),
    branchName: null,
    commitSha: null,
    prUrl: null,
    prId: null,
    llmResponse: null,
    parsedOutput: null,
    reviewVerdict: null,
    reviewCycle: 0,
    costUsd: 0,
    error: null,
    updatedAt: new Date().toISOString(),
  }
}

test('saves and retrieves state', async () => {
  const store = createStateStore(TEST_DIR)
  const state = makeState('issue-1', 'building_context')

  await store.save(state)
  const loaded = await store.get('issue-1')

  expect(loaded).not.toBeNull()
  expect(loaded!.issueId).toBe('issue-1')
  expect(loaded!.step).toBe('building_context')
})

test('returns null for missing state', async () => {
  const store = createStateStore(TEST_DIR)
  const loaded = await store.get('nonexistent')
  expect(loaded).toBeNull()
})

test('lists all states', async () => {
  const store = createStateStore(TEST_DIR)
  await store.save(makeState('issue-1', 'done'))
  await store.save(makeState('issue-2', 'failed'))
  await store.save(makeState('issue-3', 'calling_llm'))

  const states = await store.list()
  expect(states.length).toBe(3)
})

test('overwrites existing state', async () => {
  const store = createStateStore(TEST_DIR)
  await store.save(makeState('issue-1', 'pending'))
  await store.save(makeState('issue-1', 'done'))

  const loaded = await store.get('issue-1')
  expect(loaded!.step).toBe('done')
})
