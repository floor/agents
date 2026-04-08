# Experiment: Fourth Sprint — Native Worktree Execution

**Date:** April 8, 2026
**Objective:** Test the native agent execution mode (git worktree + Claude Code editing files directly)

---

## What Changed

- Native execution mode: Claude Code spawns on a `git worktree` and edits files directly
- No more tool-use adapter hack — Claude Code uses its own Read/Edit/Write/Bash tools
- CTO review also uses worktree (can run typecheck + tests)

## Iterations

### Attempt 1: CI=true blocks editing
Claude Code with `CI=true` runs read-only. All 5 tasks completed with "no changes to commit."
**Fix:** Removed `CI=true`, added `--allowedTools Read,Edit,Write,Bash,Glob,Grep`.

### Attempt 2: Auth failure without CI=true
Without `CI=true`, Claude Code requires interactive OAuth login. All tasks fail with "Not logged in."
**Fix:** Passed full `process.env` (including `ANTHROPIC_API_KEY`) for auth. TODO: use `claude setup-token` for Max plan auth.

### Attempt 3: Stale branches
Branches from previous sprints had no common history with main (due to `git filter-branch`). PR creation failed with "no history in common."
**Fix:** Deleted all old agent branches.

### Attempt 4: Partial success
- Claude Code successfully edited files and exited cleanly (exit 0)
- `commitAndPushWorktree` committed changes but git push failed
- Linear API rate limit hit (5000 req/hr) from repeated retries

## Results

| Task | Claude Code | Committed | Pushed | PR | Notes |
|------|:-----------:|:---------:|:------:|:--:|-------|
| FLO-13 Workflow engine | 4m 16s, $0.74 | Yes | Failed | No | Push error |
| FLO-14 Metrics | 2m 39s, $0.55 | Yes | Failed | No | Push error |
| FLO-10 CTO tests | 2m 7s, $0.62 | — | — | No | Linear rate limited |
| FLO-11 Context v2 | 23s, $0.15 | No changes | — | No | Already done? |
| FLO-12 Branch checkout | — | — | — | No | Linear rate limited |

## Remaining Issues

### 1. Git push from worktree fails
Claude Code edits and commits in the worktree, but `git push origin <branch>` fails. Needs investigation — might be git config, auth, or remote tracking issues in the worktree context.

### 2. Linear rate limiting
The 5-second polling interval + multiple error retries burns through Linear's 5000 req/hr limit. Needs:
- Exponential backoff on errors
- Longer polling interval (30s as the spec originally suggested)
- Respect `Retry-After` headers

### 3. Auth for Max plan
`claude setup-token` should be run to set up long-lived Max plan auth. Currently using `ANTHROPIC_API_KEY` which bills per-token.

## Progress

The native execution architecture works:
- Worktrees create/remove correctly
- Claude Code reads the codebase and edits files in the worktree
- Changes are committed locally
- The last mile (push to remote) needs fixing

This is close — one more fix and we'll have the full loop: worktree → Claude Code edits → commit → push → PR → CTO review on worktree.
