# Adding a Task Manager

This guide walks through adding a new task manager provider to the `@floor-agents/task` package.

## Overview

All task adapters live in `packages/task/src/`, each in its own subfolder. They implement the `TaskAdapter` type from `@floor-agents/core` and are registered in the factory.

## Steps

### 1. Create the provider folder

```bash
mkdir packages/task/src/github-issues
```

### 2. Implement the adapter

**`packages/task/src/github-issues/index.ts`:**

```typescript
import type {
  TaskAdapter,
  Issue,
  IssueEvent,
  IssueStatus,
} from '@floor-agents/core'

export type GitHubIssuesConfig = {
  readonly token: string
  readonly owner: string
  readonly repo: string
}

export function createGitHubIssuesAdapter(config: GitHubIssuesConfig): TaskAdapter {
  return {
    async *watchIssues(filters) {
      // Poll GitHub Issues API for issues with matching labels
      // Yield IssueEvent objects (created/updated/deleted)
      // Must be an async generator that runs indefinitely
    },

    async getIssue(issueId) {
      // GET /repos/{owner}/{repo}/issues/{number}
      // Return Issue or null
    },

    async createIssue(data, parentId) {
      // POST /repos/{owner}/{repo}/issues
      // Return the created Issue
    },

    async updateIssue(issueId, changes) {
      // PATCH /repos/{owner}/{repo}/issues/{number}
    },

    async addComment(issueId, text) {
      // POST /repos/{owner}/{repo}/issues/{number}/comments
    },

    async setStatus(issueId, status) {
      // Map IssueStatus to GitHub state (open/closed)
      // Or use project board columns
    },

    async setLabel(issueId, label) {
      // POST /repos/{owner}/{repo}/issues/{number}/labels
    },

    async removeLabel(issueId, label) {
      // DELETE /repos/{owner}/{repo}/issues/{number}/labels/{label}
    },
  }
}
```

### 3. Key implementation patterns

**`watchIssues` must be an async generator** that:
1. Does an initial scan and yields all matching issues as `'created'` events
2. Polls for changes (or listens to webhooks) indefinitely
3. Tracks known issues to detect created/updated/deleted events
4. Cleans up resources in a `finally` block

See `packages/task/src/linear/index.ts` for a polling-based example.

**Status mapping**: map your provider's statuses to the internal `IssueStatus` type:
```typescript
type IssueStatus = 'backlog' | 'triage' | 'in_progress' | 'in_review' | 'qa' | 'done' | 'changes_requested'
```

### 4. Register in the factory

**`packages/task/src/index.ts`** — add the new type and case:

```typescript
import { createGitHubIssuesAdapter } from './github-issues/index.ts'

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
```

### 5. Wire up in main.ts

Add a case to the task adapter switch in `src/main.ts`:

```typescript
case 'github-issues':
  return createTaskAdapter({
    type: 'github-issues',
    githubIssues: {
      token: requireEnv('GITHUB_TOKEN'),
      owner: requireEnv('GITHUB_OWNER'),
      repo: requireEnv('GITHUB_ISSUES_REPO'),
    },
  })
```

### 6. Add tests

**`test/task/github-issues.test.ts`** — test the adapter shape and any pure functions (status mapping, etc.).

### 7. Verify

```bash
bun install
bun run typecheck
bun test
```
