# @floor-agents/github

Git adapter for [GitHub](https://github.com). Reads code, creates branches, commits files, and opens PRs via the GitHub REST API.

## Structure

```
packages/github/src/
├── index.ts       ← re-exports
└── adapter.ts     ← createGitHubAdapter, GitHubError
```

## Usage

```typescript
import { createGitHubAdapter } from '@floor-agents/github'

const git = createGitHubAdapter({
  token: 'ghp_...',
  owner: 'my-org',
  baseUrl: 'https://api.github.com', // optional
})

// Read a file
const file = await git.getFile('my-repo', 'src/index.ts')

// Create a branch, commit, and open a PR
await git.createBranch('my-repo', 'agent/fix-bug')
await git.commitFiles('my-repo', 'agent/fix-bug', [
  { path: 'src/index.ts', content: '...' }
], 'Fix the bug')
const pr = await git.createPR('my-repo', 'agent/fix-bug', 'Fix the bug', 'Description...')
```

## Methods

| Method | Description |
|--------|-------------|
| `getFile(repo, path, ref?)` | Get file content (base64 decoded) |
| `getTree(repo, path, ref?)` | List directory entries |
| `createBranch(repo, name, fromRef?)` | Create branch from ref |
| `commitFiles(repo, branch, files, message)` | Create blobs + tree + commit + update ref |
| `createPR(repo, branch, title, body)` | Open a pull request |
| `getPRDiff(repo, prId)` | Get PR diff |
| `addPRComment(repo, prId, body)` | Add a comment to PR |
| `mergePR(repo, prId)` | Squash merge a PR |
| `getRecentCommits(repo, path, n?)` | Get recent commits for a path |

## Idempotent Operations

Key methods are idempotent for crash recovery:

- **`createBranch`**: catches 422 (branch already exists) and returns success
- **`createPR`**: checks for existing open PR on the branch before creating a new one
- **`commitFiles`**: creates a fresh tree and force-updates the branch ref, overwriting any partial state from a previous crash

## Error Handling

Throws `GitHubError` with `status` and `endpoint` properties:
- 401 → authentication failure
- 403 → permission denied
- 404 → not found (for `getFile`, returns `null` instead)
- 422 → validation error (context-dependent)
- 429 → rate limited (retries with `Retry-After`)

## Config

Requires env vars:
- `GITHUB_TOKEN` — personal access token with repo scope
- `GITHUB_OWNER` — org or user that owns the repos
