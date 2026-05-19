# Floor Agents

AI engineering team as a service. Connects to GitHub + Linear + LLM providers → autonomous agents decompose tasks, write code, open PRs, review, and QA. See `docs/architecture.md` for full context.

## Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict, no `any`)
- **Module system:** ESM
- **Structure:** Bun workspaces, packages live in `packages/`
- **Config:** YAML at `config/templates/default.yaml`

## Packages

| Package | Role |
|---------|------|
| `@floor-agents/core` | types, config loader, YAML validation, utilities |
| `@floor-agents/orchestrator` | main loop, state machine, guardrails, cost tracking |
| `@floor-agents/context-builder` | context assembly + prompt rendering |
| `@floor-agents/anthropic` | Anthropic adapter (tool use) |
| `@floor-agents/claude-code` | Claude Code adapter (spawns CLI, full codebase access) |
| `@floor-agents/lmstudio` | Local model adapter (Gemma, Llama, Qwen, etc.) |
| `@floor-agents/gemini` | Google Gemini adapter |
| `@floor-agents/openai` | OpenAI-compatible adapter (OpenAI, Ollama, Together, Groq) |
| `@floor-agents/github` | GitHub git adapter + Discussions sync |
| `@floor-agents/task` | Task manager adapters (Linear, Things 3, GitHub Issues) |
| `@floor-agents/gateway` | WebSocket server for external agents (auth, validation, reconnection) |

**Entry point:** `src/main.ts` (the orchestrator lives in `src/`, not under `packages/`)

## Commands

```bash
bun run src/main.ts  # start the orchestrator
bun test             # run tests
bun run typecheck    # type check without emitting
```

## Execution Modes

### Dev Mode
Standard pipeline — agents write code, CTO reviews, iterate.

```
Backlog → Triage → In Progress → In Review → QA → Done
                       ↑               │
                       └── Changes Requested (max 3 cycles → Needs Human)
```

### Committee Mode
Multiple agents review proposals in parallel and vote. Activated when agents have `vote` capability.

```
Issue (labeled "committee")
  → All agents review in parallel (internal + external)
  → Each casts APPROVE / REJECT / ABSTAIN
  → Majority wins → outcome posted
```

External agents (e.g. Codex) connect via the gateway WebSocket. Internal agents are dispatched directly.

## Workflow State Machine

**State transitions defined in YAML config under `workflow.transitions`.** Each transition has a `trigger` type and an `agentId` — the agent that acts when entering that state.

| State | Who acts | Trigger |
|-------|----------|---------|
| Backlog | — | Label `floor` added to issue |
| Triage | PM agent | Decomposes into sub-issues |
| In Progress | Backend/Frontend agent | Sub-tasks created |
| In Review | CTO agent | Agent completes PR |
| Changes Requested | Backend/Frontend | CTO rejects |
| QA | QA agent | CTO approves |
| Done | — | QA passes |
| Needs Human | — | 3 review cycles exceeded |

## Adapter Patterns

**All adapters must satisfy their interface in `@floor-agents/core`.**

### Task Manager Adapter

```typescript
createTaskAdapter({ type: 'linear', linear: { apiKey, teamId } })
```

Interface: `watchIssues`, `getIssue`, `createIssue`, `updateIssue`, `addComment`, `setStatus`, `setLabel`, `removeLabel`

Ships with: Linear. Next: GitHub Issues, Jira.

### Git Adapter

```typescript
createGitAdapter({ type: 'github', token, owner, repo })
```

Interface: `getFile`, `getTree`, `createBranch` (idempotent — 422 = already exists → success), `commitFiles`, `createPR` (checks for existing open PR first), `getPRDiff`, `addPRComment`, `mergePR`

Ships with: GitHub. Next: GitLab, Bitbucket.

### LLM Adapter

Agents produce output via **tool use, not text parsing**. Two tools:
- `write_file(path, content)` — create or modify file
- `pr_description(title, description)` — set the PR

The orchestrator runs a **conversation loop**: call LLM → collect tool calls → acknowledge → repeat until `stopReason !== 'tool_use'`.

## Adding a New Adapter

1. Add implementation in the relevant package (`@floor-agents/task`, `@floor-agents/github`, or a new LLM package)
2. Implement the interface defined in `@floor-agents/core`
3. Register in the factory function (`createTaskAdapter` / `createGitAdapter`)
4. Add config type to the YAML schema in `@floor-agents/core`
5. Add tests in `test/`

## Config YAML Structure

```yaml
project:
  name, repo, language, runtime, conventions, structure, packages, customInstructions

agents:
  - id, name, promptTemplate, llm (provider, model, temperature, maxTokens), capabilities, autonomy

workflow:
  states: [{ id, label, taskManagerStatus, terminal }]
  transitions: [{ from, to, trigger, agentId, maxCycles?, fallbackState? }]

chain:
  nodes: [{ agentId, receivesFrom, dispatchesTo, reportsTo, canApprove, canReject }]

guardrails:
  maxFilesPerTask, maxFileSizeBytes, maxTotalOutputBytes, blockedPaths, blockedExtensions

costs:
  maxCostPerTask, maxCostPerDay, warnCostThreshold
```

**Guardrails — blocked by default:** `.env*`, `*.pem`, `*.key`, `.github/workflows/*`, `Dockerfile`, `package.json`, `bun.lock`

## System Prompts

```
Final prompt = Base role prompt + Project context layer + Custom instructions + Tool use instructions
```

Base prompts live in `agents/` (e.g. `agents/backend-dev.md`, `agents/cto.md`). Project context is generated from YAML config.

## Conventions

- `Bun.$` for shell commands — not `execa` or `child_process`
- `Bun.file` over `node:fs` for file reads/writes
- `bun:test` for tests
- No semicolons, single quotes, 2-space indent
- `type` over `interface` for object shapes
- No `any` — use `unknown` or proper interfaces
- Conventional commits: `feat(orchestrator): description`, `fix(github): description`, `perf(llm): description`

## Key Files to Read First

- `docs/architecture.md` — full system design and adapter contracts
- `docs/gateway.md` — WebSocket protocol, REST fallback, external agent integration
- `docs/configuration.md` — YAML schema details
- `config/templates/default.yaml` — canonical working example
- `packages/core/src/types/` — all shared types
- `packages/gateway/src/` — gateway server, client, protocol types
- `src/main.ts` — orchestrator entry point
