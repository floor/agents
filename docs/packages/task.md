# @floor-agents/task

Task manager adapters with a factory pattern. Watches for issues, manages comments/labels/statuses.

## Structure

```
packages/task/src/
├── index.ts              ← factory + re-exports
├── linear/
│   ├── index.ts          ← createLinearAdapter
│   └── graphql.ts        ← Linear GraphQL client
├── things/
│   ├── index.ts          ← createThingsAdapter
│   ├── applescript.ts    ← macOS AppleScript bridge
│   └── watcher.ts        ← SQLite DB file watcher
└── github-issues/
    └── index.ts          ← createGitHubIssuesAdapter
```

## Factory Usage

```typescript
import { createTaskAdapter } from '@floor-agents/task'

// GitHub Issues
const task = createTaskAdapter({
  type: 'github-issues',
  githubIssues: { token: 'ghp_...', owner: 'my-org', repo: 'my-repo' },
})

// Linear
const task = createTaskAdapter({
  type: 'linear',
  linear: { apiKey: 'lin_api_...', teamId: '...' },
})

// Things 3 (macOS only)
const task = createTaskAdapter({ type: 'things' })
```

## TaskAdapter Interface

All adapters implement the `TaskAdapter` type from `@floor-agents/core`:

| Method | Description |
|--------|-------------|
| `watchIssues(filters?)` | Async iterable of issue events (created/updated/deleted) |
| `getIssue(id)` | Get a single issue by ID |
| `createIssue(data, parentId?)` | Create a new issue |
| `updateIssue(id, changes)` | Update issue fields |
| `addComment(id, text)` | Add a comment |
| `setStatus(id, status)` | Change issue status |
| `setLabel(id, label)` | Add a label |
| `removeLabel(id, label)` | Remove a label |

## Linear Adapter

- Polls the Linear GraphQL API every 5 seconds
- Tracks known issues by `updatedAt` timestamp to detect changes
- Caches workflow states and labels for efficient lookups
- Maps Linear state types to internal `IssueStatus`:
  - `backlog` → `backlog`
  - `unstarted` → `triage`
  - `started` → `in_progress`
  - `completed` → `done`
  - `cancelled` → `done`

Requires: `LINEAR_API_KEY`, `LINEAR_TEAM_ID`

## Things 3 Adapter

- macOS only — communicates with Things 3 via AppleScript (`osascript`)
- Watches the Things SQLite database file for changes (debounced at 500ms)
- Maps Things statuses: `open` → `backlog`, `completed`/`cancelled` → `done`
- Comments are appended to the todo's notes field with a timestamp

Requires: Things 3 installed on macOS. No API keys needed.

## GitHub Issues Adapter

Created by the AI team (Claude Code Sonnet, sprint 2).

- Uses the GitHub REST API to poll for issues with a specific label
- Maps GitHub issue states (`open`/`closed`) to internal `IssueStatus`
- Labels map directly to GitHub issue labels
- Comments via the GitHub issues API

Requires: `GITHUB_TOKEN` with repo scope, plus `GITHUB_OWNER` and repo name.

```typescript
createTaskAdapter({
  type: 'github-issues',
  githubIssues: { token: '...', owner: 'my-org', repo: 'my-repo' },
})
```

## Adding a New Provider

See [Adding a Task Manager](../guides/adding-task-manager.md).
