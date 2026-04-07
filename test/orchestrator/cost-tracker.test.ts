import { test, expect } from 'bun:test'
import { createCostTracker } from '@floor-agents/orchestrator'
import type { CostConfig } from '@floor-agents/core'

const costConfig: CostConfig = {
  maxCostPerTask: 5.0,
  maxCostPerDay: 50.0,
  warnCostThreshold: 2.0,
}

test('tracks per-task cost', () => {
  const tracker = createCostTracker()
  tracker.recordCost('task-1', 1.5)
  tracker.recordCost('task-1', 0.5)

  expect(tracker.getTaskCost('task-1')).toBe(2.0)
  expect(tracker.getTaskCost('task-2')).toBe(0)
})

test('tracks daily cost', () => {
  const tracker = createCostTracker()
  tracker.recordCost('task-1', 3.0)
  tracker.recordCost('task-2', 2.0)

  expect(tracker.getDailyCost()).toBe(5.0)
})

test('blocks new tasks when daily limit reached', () => {
  const tracker = createCostTracker()
  tracker.recordCost('task-1', 50.0)

  expect(tracker.canStartNewTask(costConfig)).toBe(false)
})

test('allows new tasks under daily limit', () => {
  const tracker = createCostTracker()
  tracker.recordCost('task-1', 10.0)

  expect(tracker.canStartNewTask(costConfig)).toBe(true)
})

test('warns when task exceeds threshold', () => {
  const tracker = createCostTracker()
  tracker.recordCost('task-1', 3.0)

  const check = tracker.checkTaskCost('task-1', costConfig)
  expect(check.ok).toBe(true)
  expect(check.message).toBeDefined()
})

test('fails when task exceeds max', () => {
  const tracker = createCostTracker()
  tracker.recordCost('task-1', 6.0)

  const check = tracker.checkTaskCost('task-1', costConfig)
  expect(check.ok).toBe(false)
})
