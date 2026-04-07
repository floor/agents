# Experiment: Third Sprint — Claude Code Sonnet on harder tasks

**Date:** April 8, 2026
**Objective:** Run FLO-10 through FLO-14 (architectural improvements) with Claude Code Sonnet + Opus

---

## Team Composition

Same as sprint 2: Claude Code Sonnet (dev) + Claude Code Opus (CTO).

## Results

| Issue | Title | Status | Time | Cost | Notes |
|-------|-------|:------:|:----:|:----:|-------|
| FLO-13 | Workflow engine | **Failed** | 10m+ | $1.03 | Timeout (exit 143). Too complex for one session. |
| FLO-12 | Dev agent on branch | **Failed** | 10m+ | — | Timeout. Same issue — too complex. |
| FLO-11 | Context builder v2 | **PR #11** | 2m 23s | $0.27 | Import tracing. Approved + merged. |
| FLO-10 | CTO run tests | In progress | — | — | Running when session ended. |
| FLO-14 | Metrics collector | In progress | — | — | Running when session ended. |

## What went wrong

### 1. Claude Code adapter is architecturally flawed

The `@floor-agents/claude-code` adapter wraps Claude Code CLI but forces it through our `write_file` / `pr_description` tool-use pipeline. This is a fundamental mismatch:

- **Claude Code is an agent**, not an API. It has its own tools (Read, Edit, Write, Bash, Grep). Asking it to respond with JSON tool calls is asking an agent to pretend it's an API.
- The adapter parses `data.result` from the CLI JSON output, but this field can be `undefined` when Claude Code encounters errors or produces long outputs.
- Claude Code modifies files directly as it works, causing side effects outside the task scope (it modified the adapter itself, the orchestrator, docs).

### 2. Complex tasks exceed the 10-minute timeout

The workflow engine (FLO-13) and branch checkout (FLO-12) are multi-file architectural changes. Claude Code Sonnet spent 8m 51s generating 33K tokens of output for FLO-13 but produced no tool calls — it wrote the code as prose instead of using `write_file`. The retry also timed out.

### 3. The CTO still approves everything

Even with the updated prompt asking the CTO to run typecheck and tests, the review happens via diff only (not on a checked-out branch). The CTO has no way to run commands against the actual code.

### 4. Agents modify files outside their scope

Claude Code has full file access. During sprint 3, the dev agent modified:
- `packages/claude-code/src/adapter.ts` (reverting our bug fix)
- `packages/orchestrator/src/index.ts` (adding metrics exports)
- `docs/packages/orchestrator.md` (adding metrics docs)
- `packages/context-builder/src/file-selector.ts` (modifying during its own task)

This is because Claude Code reads the codebase and "helps" by making changes beyond the task scope.

## The core architectural problem

The orchestrator was designed for stateless LLM API calls:
1. Build context (files + prompt)
2. Call LLM API
3. Parse tool calls from response
4. Commit the files

Claude Code doesn't fit this model. It's a stateful agent that:
- Reads files on its own (doesn't need our context builder)
- Edits files directly (doesn't use `write_file` tool calls)
- Runs commands (can do its own typecheck/test)
- Has memory across turns within a session

**Three paths forward:**

### Option A: API adapters for dev, Claude Code for CTO only
Go back to what worked: Gemma/LM Studio or Anthropic API for dev agents (through our tool-use pipeline), Claude Code only for CTO reviews (where it reads diffs, not writes code). This is the conservative path.

### Option B: Fix the Claude Code adapter
Make the adapter more robust: better error handling, stricter scoping (restrict allowed tools), better prompt engineering to force tool-use output format. This is a band-aid.

### Option C: Native Claude Code execution mode
Build a new execution mode where Claude Code works directly on a checked-out branch with its own tools. The orchestrator:
1. Creates a branch
2. Checks out the branch in a temp directory
3. Spawns Claude Code with `--cwd` pointing to the checkout
4. Lets it read, edit, run tests natively
5. Collects the git diff after it finishes
6. Pushes the branch and creates a PR

This is FLO-12 — the task that timed out. It's the right architecture but it's a significant change.

## Comparison across all three sprints

| Metric | Sprint 1 (Gemma) | Sprint 2 (Sonnet API) | Sprint 3 (Sonnet CLI) |
|--------|:-----------------:|:---------------------:|:---------------------:|
| Tasks attempted | 5 | 5 | 5 |
| PRs created | 5 | 5 | 1 |
| PRs merged | 2 | 5 | 1 |
| Failures | 0 | 0 | 2 timeouts |
| Cost | $0.32 | $1.23 | $1.30+ |
| Task complexity | Simple | Simple | Complex |
| Code quality | Needs cleanup | Production-ready | N/A (timeouts) |

Sprint 2 (Claude Code Sonnet through the API adapter on simple tasks) was the sweet spot. Sprint 3 shows the limits of the current architecture on complex tasks.
