# First Run Guide

How to run Floor Agents end-to-end with a real team: Gemma (local coder) + Claude Code Opus (CTO reviewer).

## Prerequisites

- [x] Bun installed
- [x] LM Studio running with Gemma 4 E2B loaded
- [x] GitHub repo accessible with `GITHUB_TOKEN`
- [x] Linear workspace with `LINEAR_API_KEY` and team/project configured
- [x] `.env` populated (see below)

## Environment Setup

```bash
# .env
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=floor

TASK_ADAPTER=linear
LINEAR_API_KEY=lin_api_...
LINEAR_TEAM_ID=FLO
LINEAR_PROJECT_ID=...          # optional: scope to a specific project

LMSTUDIO_BASE_URL=http://localhost:1234/v1

CONFIG_PATH=config/templates/default.yaml
STATE_DIR=./data/executions
```

## Default Team Composition

The default config (`config/templates/default.yaml`) sets up:

| Agent | Provider | Model | Role |
|-------|----------|-------|------|
| Backend Dev | LM Studio | Gemma 4 E2B | Writes code |
| Frontend Dev | LM Studio | Gemma 4 E2B | Writes code |
| CTO | Claude Code | Opus 4.6 | Reviews PRs |
| PM | Anthropic API | Sonnet | Decomposes tasks |
| QA | Anthropic API | Sonnet | Writes tests |

Phase 1 exercises: Backend Dev + CTO. PM and QA are defined but not active in the pipeline yet.

## Linear Setup

### Labels

The orchestrator watches for issues with the `agent` label. Create these labels in Linear:

- `agent` — triggers the orchestrator
- `backend` — dispatches to the Backend Dev agent
- `frontend` — dispatches to the Frontend Dev agent
- `needs-human` — set by the orchestrator when it can't proceed

### Creating Issues

Issues should have:
- The `agent` label (required — this is what the orchestrator watches for)
- A role label like `backend` (optional — defaults to first agent with `write_code` capability)
- A clear title and description with enough context for the agent

Good example:
```
Title: Add a slugify utility to @floor-agents/core
Labels: agent, backend

Body:
Create `packages/core/src/utils/slugify.ts` with a `slugify(text: string): string` function.

Requirements:
- Convert to lowercase
- Replace non-alphanumeric characters with hyphens
- Collapse consecutive hyphens
- Trim leading/trailing hyphens
- Truncate to 50 characters

Export it from `packages/core/src/index.ts`.
Write tests in `test/core/slugify.test.ts` using `bun:test`.
```

## Running

```bash
bun run src/main.ts
```

Expected output:
```
[floor-agents] starting
  company:   Default Team
  project:   floor-agents (agents)
  agents:    backend (lmstudio), frontend (lmstudio), pm (anthropic), cto (claude-code), qa (anthropic)
  task:      linear
  providers: lmstudio, claude-code, anthropic

[orchestrator] starting...
[orchestrator] team mode: dev agents + CTO / Tech Lead (claude-code)
[orchestrator] watching for tasks...
```

## What Happens

When the orchestrator picks up an issue:

1. **Dispatcher** matches the issue labels to an agent (e.g. `backend` → Backend Dev)
2. **Context builder** reads the repo tree, selects relevant files by keyword matching
3. **Gemma** (via LM Studio) receives the system prompt + task and calls `write_file` / `pr_description` tools
4. **Guardrails** validate the output (file count, size, blocked paths)
5. **GitHub adapter** creates a branch, commits files, opens a PR
6. **CTO** (Claude Code + Opus) reviews the PR diff, posts a review comment
7. If approved → issue updated to "In Review", done
8. If changes requested → Gemma revises with the feedback (up to 3 cycles)

## Dry Run Results (April 2026)

First test with FLO-5 ("Add a slugify utility to @floor-agents/core"):

| Metric | Value |
|--------|-------|
| Model | google/gemma-4-e2b (local) |
| Turns | 5 |
| Tokens | 8,919 in / 2,034 out |
| Cost | $0.00 |
| Time | ~42 seconds |
| Files produced | 3 (implementation, barrel export, tests) |
| Quality | Correct implementation, 8 tests, clean PR description |

The agent correctly:
- Created `packages/core/src/utils/slugify.ts` meeting all 5 requirements
- Updated the barrel export in `packages/core/src/index.ts`
- Wrote 8 tests covering happy path, edge cases, empty string, truncation
- Produced a clear PR description

## Troubleshooting

### LM Studio not responding
- Check `curl http://localhost:1234/v1/models` returns models
- Ensure a model is loaded (not just downloaded)

### Linear 400 errors
- Verify `LINEAR_TEAM_ID` is the team key (e.g. `FLO`), not a UUID
- Check `LINEAR_API_KEY` is valid

### GitHub 404 errors
- `project.repo` in the YAML should be just the repo name (e.g. `agents`), not `owner/repo`
- The owner comes from `GITHUB_OWNER` env var

### No issues picked up
- Ensure issues have the `agent` label
- If using `LINEAR_PROJECT_ID`, ensure issues are in that project
- Check the orchestrator log for `[skip]` messages
