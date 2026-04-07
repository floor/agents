import type { TaskAdapter } from '@floor-agents/core'
import { createLinearAdapter } from './linear/index.ts'
import { createThingsAdapter } from './things/index.ts'
import { createGitHubIssuesAdapter } from './github-issues/index.ts'
import type { LinearAdapterConfig } from './linear/graphql.ts'
import type { GitHubIssuesConfig } from './github-issues/index.ts'

export type TaskAdapterType = 'linear' | 'things' | 'github-issues'

export type TaskAdapterConfig =
  | { readonly type: 'linear'; readonly linear: LinearAdapterConfig }
  | { readonly type: 'things' }
  | { readonly type: 'github-issues'; readonly githubIssues: GitHubIssuesConfig }

export function createTaskAdapter(config: TaskAdapterConfig): TaskAdapter {
  switch (config.type) {
    case 'linear':
      return createLinearAdapter(config.linear)
    case 'things':
      return createThingsAdapter()
    case 'github-issues':
      return createGitHubIssuesAdapter(config.githubIssues)
    default:
      throw new Error(`Unknown task adapter type: ${(config as any).type}`)
  }
}

// Re-export individual adapters for direct use
export { createLinearAdapter } from './linear/index.ts'
export { createThingsAdapter } from './things/index.ts'
export { createGitHubIssuesAdapter } from './github-issues/index.ts'
export type { LinearAdapterConfig } from './linear/graphql.ts'
export type { GitHubIssuesConfig } from './github-issues/index.ts'
