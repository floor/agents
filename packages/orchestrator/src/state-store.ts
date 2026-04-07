import { readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionState, StateStore } from '@floor-agents/core'

export function createStateStore(dir: string): StateStore {
  return {
    async get(issueId) {
      const path = join(dir, `${issueId}.json`)
      const file = Bun.file(path)

      if (!await file.exists()) return null

      try {
        return await file.json() as ExecutionState
      } catch {
        console.error(`[state] corrupt state file: ${path}`)
        return null
      }
    },

    async save(state) {
      const tmpPath = join(dir, `${state.issueId}.tmp`)
      const finalPath = join(dir, `${state.issueId}.json`)

      const updated: ExecutionState = {
        ...state,
        updatedAt: new Date().toISOString(),
      }

      await Bun.write(tmpPath, JSON.stringify(updated, null, 2))
      await rename(tmpPath, finalPath)
    },

    async list() {
      try {
        const entries = await readdir(dir)
        const states: ExecutionState[] = []

        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue
          const file = Bun.file(join(dir, entry))
          try {
            states.push(await file.json() as ExecutionState)
          } catch {
            console.error(`[state] corrupt state file: ${entry}`)
          }
        }

        return states
      } catch {
        return []
      }
    },
  }
}
