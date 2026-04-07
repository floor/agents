import type { CostConfig } from '@floor-agents/core'

export type CostTracker = {
  recordCost(taskId: string, cost: number): void
  getDailyCost(): number
  getTaskCost(taskId: string): number
  canStartNewTask(costConfig: CostConfig): boolean
  checkTaskCost(taskId: string, costConfig: CostConfig): { ok: boolean; message?: string }
}

function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10)
}

export function createCostTracker(): CostTracker {
  const taskCosts = new Map<string, number>()
  let dailyTotal = 0
  let currentDay = getUtcDateKey()

  function resetIfNewDay() {
    const today = getUtcDateKey()
    if (today !== currentDay) {
      dailyTotal = 0
      currentDay = today
    }
  }

  return {
    recordCost(taskId, cost) {
      resetIfNewDay()
      const current = taskCosts.get(taskId) ?? 0
      taskCosts.set(taskId, current + cost)
      dailyTotal += cost
    },

    getDailyCost() {
      resetIfNewDay()
      return dailyTotal
    },

    getTaskCost(taskId) {
      return taskCosts.get(taskId) ?? 0
    },

    canStartNewTask(costConfig) {
      resetIfNewDay()
      return dailyTotal < costConfig.maxCostPerDay
    },

    checkTaskCost(taskId, costConfig) {
      const taskCost = taskCosts.get(taskId) ?? 0

      if (taskCost > costConfig.maxCostPerTask) {
        return {
          ok: false,
          message: `Task cost $${taskCost.toFixed(2)} exceeds limit $${costConfig.maxCostPerTask.toFixed(2)}`,
        }
      }

      if (taskCost > costConfig.warnCostThreshold) {
        return {
          ok: true,
          message: `Task cost $${taskCost.toFixed(2)} exceeds warning threshold $${costConfig.warnCostThreshold.toFixed(2)}`,
        }
      }

      return { ok: true }
    },
  }
}
