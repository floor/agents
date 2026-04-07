import type { TaskAdapter } from '@floor-agents/core'
import { createLinearAdapter } from './linear/index.ts'
import { createThingsAdapter } from './things/index.ts'
import type { LinearAdapterConfig } from './linear/graphql.ts'

export type TaskAdapterType = 'linear' | 'things'

export type TaskAdapterConfig =
  | { readonly type: 'linear'; readonly linear: LinearAdapterConfig }
  | { readonly type: 'things' }

export function createTaskAdapter(config: TaskAdapterConfig): TaskAdapter {
  switch (config.type) {
    case 'linear':
      return createLinearAdapter(config.linear)
    case 'things':
      return createThingsAdapter()
    default:
      throw new Error(`Unknown task adapter type: ${(config as any).type}`)
  }
}

// Re-export individual adapters for direct use
export { createLinearAdapter } from './linear/index.ts'
export { createThingsAdapter } from './things/index.ts'
export type { LinearAdapterConfig } from './linear/graphql.ts'
