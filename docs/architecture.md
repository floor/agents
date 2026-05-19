# Floor Agents — Architecture

**Company:** Floor IO SA
**Updated:** May 2026

---

## 1. What Is Floor Agents

Floor Agents is an autonomous AI engineering framework. You define a team of AI agents in a YAML config, connect your existing tools (GitHub, Linear, any LLM provider), and the orchestrator runs them against your codebase — writing code, reviewing PRs, voting on proposals, and managing issues.

It runs locally on your machine or server. No hosted service, no proprietary UI. All work happens in your Linear and GitHub.

### 1.1 What It Solves

**The multi-model coordination problem.** AI coding tools lock you into one model from one vendor. Floor Agents lets you compose a team from any combination of providers — use a free local model for routine coding, a frontier model for code review, an external agent for a second opinion — all coordinated automatically.

**The integration problem.** AI agents that can write code still need someone to create branches, open PRs, update issue trackers, post results. Floor Agents handles the full loop: issue → context → LLM → code → PR → review → done.

**The cost problem.** API-based agents burn tokens. Floor Agents supports zero-cost configurations: Claude Code on a Max plan, local models via LM Studio, Codex on an existing OpenAI plan. A full committee review can cost $0.

### 1.2 When To Use It

- **Dev mode:** You have repetitive coding tasks in Linear. Agents pick them up, write code, open PRs, get reviewed — while you sleep.
- **Committee mode:** You have RFCs or proposals that need technical review from multiple perspectives. Agents review in parallel, vote, and post results.
- **Mixed teams:** Some agents run locally (free), some use cloud APIs (quality-critical), some are external services (Codex). One config, one orchestrator.

### 1.3 How It Works

1. Define your team in a YAML config (agents, models, capabilities)
2. Set environment variables (GitHub token, Linear key, LLM keys)
3. Run `bun run src/main.ts`
4. Create a Linear issue with the right label → agents handle the rest

---

## 2. Principles

- **Customer's tools, not ours.** We don't replace GitHub or Linear. We orchestrate them.
- **Vendor-agnostic AI.** Customers choose their LLM providers. We don't lock them in.
- **Project-agnostic.** Works with any language, any framework, any repo structure. The customer defines their conventions.
- **Pluggable everything.** Task managers, git platforms, LLM providers — all behind adapters. Add new integrations without touching core logic.
- **Transparent.** Every decision an agent makes is traceable. Every action is logged in the customer's tools (issue comments, PR descriptions, commit messages).
- **Humans are the safety net.** Agents run autonomously. Humans review output (PRs), not input (task assignments).

---

## 3. System Architecture

### 3.1 High-Level Overview

```
                    ┌─────────────┐
                    │  YAML Config │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ Orchestrator │──── watches for issues
                    └──────┬──────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     ┌──────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
     │ LLM Adapters │ │ Context  │ │   Gateway   │
     │              │ │ Builder  │ │  (WebSocket) │
     │ • Claude Code│ └──────────┘ └──────┬──────┘
     │ • LM Studio │                      │
     │ • Gemini    │               ┌──────▼──────┐
     │ • OpenAI    │               │  External   │
     │ • Anthropic │               │  Agents     │
     └──────┬──────┘               │  (Codex...) │
            │                      └─────────────┘
     ┌──────▼──────┐     ┌──────────────┐
     │ Task Adapter │     │  Git Adapter  │
     │              │     │              │
     │ • Linear     │     │ • GitHub     │
     │ • Things 3   │     │   (REST +    │
     │ • GH Issues  │     │  Discussions)│
     └──────────────┘     └──────────────┘
```

### 3.2 Core Components

| Component | Purpose |
|-----------|---------|
| **Orchestrator** | Watches for new issues, dispatches to agents, manages state machine. Two modes: dev (code + review loop) and committee (parallel voting). |
| **LLM Adapters** | Vendor-agnostic interface to LLM providers. Tool use for structured output. Each agent can use a different provider. |
| **Context Builder** | Selects relevant source files for the task, assembles the prompt, manages token budget. v2 includes import tracing. |
| **Gateway** | WebSocket server for external agents. Auth, message validation, task re-queue on disconnect, REST fallback. |
| **Task Adapter** | Reads/writes issues, comments, labels, statuses. Factory pattern: `createTaskAdapter({ type, config })`. |
| **Git Adapter** | Creates branches, commits, PRs, reads files. Idempotent operations for crash recovery. |
| **State Store** | File-based JSON persistence. Execution state saved between every step for crash recovery. |
| **Cost Tracker** | Per-task and daily spending limits. Local models report $0. |

### 3.3 Adapter Interface — Task Manager

Every task management integration implements:

```
TaskAdapter:
  watchIssues(filters) → async iterable of issue events
  getIssue(issueId) → issue object
  createIssue(data, parentId?) → issue
  updateIssue(issueId, changes) → void
  addComment(issueId, text) → void
  setStatus(issueId, status) → void
  setLabel(issueId, label) → void
  removeLabel(issueId, label) → void
```

All task adapters live in the `@floor-agents/task` package with a factory:
```typescript
createTaskAdapter({ type: 'linear', linear: { apiKey, teamId } })
```

**Ships with:** Linear, Things 3, GitHub Issues
**Next:** Jira

### 3.4 Adapter Interface — Git Platform

```
GitAdapter:
  getFile(repo, path, ref) → file content
  getTree(repo, path, ref) → file listing
  createBranch(repo, name, fromRef) → void
  commitFiles(repo, branch, files[], message) → commitSha
  createPR(repo, branch, title, body) → pullRequest
  getPRDiff(repo, prId) → diff
  addPRComment(repo, prId, body) → void
  mergePR(repo, prId) → void
  getRecentCommits(repo, path, n) → commits[]
```

Key behaviors: `createBranch` is idempotent (422 = exists → success). `createPR` checks for existing open PR on branch before creating. `commitFiles` always creates a fresh tree and force-updates the ref for crash recovery.

**Ships with:** GitHub
**Next:** GitLab, Bitbucket

### 3.5 Adapter Interface — LLM Provider

```
LLMAdapter:
  run(config) → response

  config:
    provider: string
    model: string
    system: string
    messages: message[]
    tools?: ToolDefinition[]    ← structured output via tool use
    maxTokens: number
    temperature: number

  response:
    content: string             (agent reasoning/explanation)
    toolCalls: ToolCall[]       (structured file writes + PR description)
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
    usage:
      inputTokens: number
      outputTokens: number
      cost: number              (estimated USD)
    provider: string
    model: string
    durationMs: number
```

Agents produce output via **tool use**, not text parsing. Two tools are defined:
- `write_file(path, content)` — create or modify a file
- `pr_description(title, description)` — set the PR description

The orchestrator runs a conversation loop: call LLM → collect tool calls → acknowledge → repeat until `stopReason !== 'tool_use'`.

**Ships with:** Anthropic, Claude Code, OpenAI, Gemini, LM Studio
**Next:** Mistral, Ollama

---

## 4. Project Configuration

When a customer connects a repo, they create a **project**. A project defines everything agents need to know about the codebase.

### 4.1 Company Config (YAML)

The top-level `CompanyConfig` ties everything together:

```yaml
name: "Team Name"

project:
  name: "My App"
  repo: "org/my-app"
  language: "typescript"
  runtime: "bun"
  conventions:
    style: "standardjs"
    modules: "esm"
    indent: 2
    semicolons: false
    quotes: "single"
  structure:
    backend: "src/"
    frontend: "src/client/"
    tests: "test/"
  packages: []
  customInstructions: |
    We use dayjs, not moment.
    Never add a dependency without justification.

agents:
  - id: backend
    name: "Backend Developer"
    promptTemplate: "agents/backend-dev.md"
    llm:
      provider: anthropic
      model: claude-sonnet-4-20250514
      temperature: 0.2
      maxTokens: 8000
    capabilities: [read_code, write_code, create_pr, write_tests]
    autonomy: T1
    customInstructions: ""

guardrails:
  maxFilesPerTask: 20
  maxFileSizeBytes: 102400
  maxTotalOutputBytes: 512000
  blockedPaths: [".env*", "*.pem", "*.key", ".github/workflows/*"]
  allowedPaths: []
  blockedExtensions: [".env", ".pem", ".key", ".lock", ".exe", ".bin"]

costs:
  maxCostPerTask: 5.00
  maxCostPerDay: 50.00
  warnCostThreshold: 2.00

workflow: { ... }         # Phase 1: defined only
chain: { ... }            # Phase 1: defined only
autonomy: { default: T1 } # Phase 1: defined only
statusMapping: { ... }
```

This config is loaded from YAML by `@floor-agents/core` and validated for referential integrity (agent references, workflow state references, chain cycle detection).

### 4.2 System Prompts

Each agent role has a **base prompt** (maintained by Floor IO, covers the role's responsibilities and workflow rules) plus a **project layer** (generated from project config — stack, conventions, file structure).

Customers can also add **custom instructions** per agent if they want to override or extend behavior.

```
Final prompt = Base role prompt + Project context + Custom instructions + Tool use instructions
```

---

## 5. Workflow Engine

### 5.1 States

```
Backlog → Triage → In Progress → In Review → QA → Done
                       ↑               │
                       └── Changes Requested
```

These are Floor Agents internal states. They **map** to whatever states the customer uses in their task manager. Part of project setup is defining this mapping.

### 5.2 Workflow Rules

| Trigger | Action |
|---------|--------|
| New issue with `floor` label | PM picks up → decomposes into sub-issues |
| New issue with `floor` + role label (`backend`, `frontend`, ...) | Skip PM → direct to that agent |
| Issue with `bug` + role label | Skip PM → direct to agent (no decomposition needed) |
| Sub-issue unblocked | Dispatcher assigns to matching agent |
| Agent completes work | Git Manager creates branch + PR. Issue → In Review |
| Issue enters In Review | CTO agent reviews PR diff |
| CTO approves | Issue → QA |
| CTO requests changes | Issue → Changes Requested → back to agent (max 3 cycles) |
| QA passes | Issue → Done |
| QA fails | Issue → Changes Requested with QA notes |
| 3 revision cycles exceeded | Issue labeled `needs-human`. Notification sent. |

### 5.3 Dependency Management

When PM creates sub-issues, it sets dependency relations (e.g., frontend blocked-by backend). The dispatcher respects these — blocked issues stay in queue until their dependencies resolve.

---

## 6. Context Builder

This is the hardest part of the system and the most important. An agent with the wrong context produces useless code. An agent with the right context produces mergeable code.

### 6.1 Context Layers

Every agent call includes context assembled in layers:

| Layer | Content | Source |
|-------|---------|--------|
| 1. Role | Base system prompt for this agent type | Floor Agents (maintained by us) |
| 2. Project | Stack, conventions, structure, custom instructions | Project config |
| 3. Codebase | Relevant source files for this task | Git adapter (read from repo) |
| 4. Task | Issue description, acceptance criteria, parent issue context | Task manager adapter |
| 5. History | CTO review comments, previous attempts, related issue discussions | Task manager adapter + execution logs |

### 6.2 File Selection Strategy

The context builder decides which source files to include. This evolves over time:

**v1 — Keyword matching (current)**
Parse the issue text for file names, route paths, model names, function names. Pull matching files from the repo. Include the project's directory tree as an overview. Files are scored by relevance (direct match > route match > identifier match) and sorted by priority.

**v2 — Dependency tracing**
When a file is selected, also pull its direct imports. If a schema is referenced, include routes that use it. Use the project's `structure` config to know where to look.

**v3 — Embeddings-based retrieval**
Index the repo with embeddings. For each task, find the most semantically relevant files. Combine with dependency tracing.

**v4 — AST-aware**
Parse source files into ASTs. Extract function signatures, class interfaces, export maps. Include summaries of large files instead of full content. Understand the codebase at a structural level.

### 6.3 Token Budget

Each LLM call has a token limit. The context builder works within a budget:

```
Total context budget = model max tokens - reserved output tokens (4000)

Allocation:
  Role prompt:     ~1000 tokens (fixed)
  Project config:  ~500 tokens (fixed)
  Task + history:  ~2000 tokens (variable)
  Codebase files:  remaining budget (variable, prioritized)
```

If selected files exceed the budget, the builder drops lowest-relevance files first and logs what was truncated.

---

## 7. Execution Pipeline

### 7.1 State Machine

Each task progresses through discrete steps, persisted to disk for crash recovery:

```
pending → building_context → calling_llm → parsing_output → validating_output
  → creating_branch → committing_files → creating_pr → updating_issue → done
```

Any step can fail → `failed` (terminal). State is saved between each step as JSON in `./data/executions/{issueId}.json` with atomic writes (tmp + rename).

### 7.2 Guardrails

Before committing, agent output is validated:
- File count limit (`maxFilesPerTask`)
- File size limit (`maxFileSizeBytes`)
- Total output size limit (`maxTotalOutputBytes`)
- Blocked paths (glob matching: `.env*`, `*.pem`, CI configs, etc.)
- Blocked extensions (`.exe`, `.bin`, `.lock`, etc.)
- Allowed paths (if set, files must match at least one)
- Path traversal detection (no `..`, no absolute paths)

If any violations → PR is not created, issue is commented with violations, issue labeled `needs-human`.

### 7.3 Cost Controls

- **Pre-call:** Estimate cost from context token count + max output tokens. Abort if exceeds `maxCostPerTask`.
- **Post-call:** Record actual cost. Warn if exceeds `warnCostThreshold`.
- **Daily ceiling:** Track total daily spend in memory (reset at UTC midnight). Stop picking up new tasks if `maxCostPerDay` reached.

### 7.4 Crash Recovery

On startup, the orchestrator loads all execution states from disk. Incomplete tasks (not `done` or `failed`) are resumed from their current step. Steps are idempotent: `createBranch` handles 422 (exists), `createPR` checks for existing PR, `commitFiles` force-updates the ref.

---

## 8. Internal vs External Agents

Agents are either **internal** (dispatched by the orchestrator via LLM adapters) or **external** (connect themselves via the WebSocket gateway).

| Aspect | Internal | External |
|--------|----------|----------|
| Dispatch | Orchestrator calls LLM adapter directly | Gateway pushes assignment via WebSocket |
| Connection | None — orchestrator owns the call | Agent connects to `ws://host:port/ws` |
| Examples | Claude Code, Gemma (LM Studio), Gemini | Codex (OpenAI), custom agents |
| Config | `external: false` (default) | `external: true` |
| Cost tracking | Automatic (from LLM response) | Reports $0 (external billing) |

External agents receive the full task context (title, body, system prompt) over the gateway. They process it however they want and send back a result. The orchestrator doesn't need to know how they work internally.

See [Gateway documentation](./gateway.md) for the protocol spec.

---

## 9. Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Bun | Fast, TypeScript-native, built-in test runner, WebSocket server |
| Language | TypeScript (strict) | Type safety, LLM ecosystem is TS-first |
| Structure | Monorepo, Bun workspaces | Clean package boundaries, single repo |
| Config | YAML | Human-readable, supports complex nesting |
| State | File-based JSON | Simple, no dependencies, atomic writes |
| LLM output | Tool use (function calling) | Structured, typed, no parsing ambiguity |
| Gateway | Bun.serve WebSocket | Real-time external agent communication |

---

## 10. Codebase Structure

```
floor-agents/
├── packages/
│   ├── core/                 Types, config loader, YAML validation
│   ├── anthropic/            Anthropic LLM adapter (tool use)
│   ├── claude-code/          Claude Code CLI adapter (worktree execution)
│   ├── lmstudio/             LM Studio adapter (local models)
│   ├── openai/               OpenAI-compatible adapter
│   ├── gemini/               Google Gemini adapter
│   ├── github/               Git adapter + Discussions sync
│   ├── task/                 Task adapters (Linear, Things 3, GitHub Issues)
│   ├── context-builder/      File selection, prompt rendering, token budget
│   ├── orchestrator/         Dev pipeline, committee pipeline, guardrails, cost tracking
│   └── gateway/              WebSocket server + client for external agents
│
├── src/main.ts               Entry point (auto-detects dev vs committee mode)
├── scripts/codex-agent.ts    Standalone Codex external agent
├── config/templates/         YAML config templates
├── agents/                   Prompt templates
├── test/                     bun:test, mirrors package structure
└── docs/                     This documentation
```

---

## 11. Competitive Landscape

Floor Agents operates in the "AI coding agent" space. Key differentiation:

| Competitor Pattern | How Floor Agents Differs |
|---|---|
| **IDE copilots** (Copilot, Cursor, Windsurf) | They assist one developer in an editor. We run a full team autonomously. |
| **Single AI agents** (Devin, Factory, Codegen) | Single-agent, single-vendor. We run a team of specialists on any vendor. |
| **Chat-based coding** (Claude Code, ChatGPT) | Interactive, human-in-the-loop per task. We're async and autonomous. |
| **Multi-agent frameworks** (MetaGPT, CrewAI) | Frameworks, not SaaS. They don't integrate with real tools. |

**Floor Agents' moat:**
- **Multi-agent team** with specialized roles and inter-agent collaboration
- **Vendor agnostic** — customers aren't locked into one LLM
- **Pluggable integrations** — works with the customer's existing tools
- **Transparent** — all work visible in the customer's own Linear/GitHub, not in a proprietary UI
- **BYOK model** — customers own their LLM costs, Floor charges for orchestration

---

## 12. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Agents produce low-quality code | High | CTO agent review, QA validation, guardrails. Quality improves with better context builder. |
| Context builder delivers wrong files | High | Iterative improvement. v1 is conservative (include more). Customers can pin required files per agent. |
| Customer data leakage between tenants | Critical | Strict isolation. No caching of code across tenants. Security audit before launch. |
| LLM providers change APIs or pricing | Medium | Adapter pattern isolates changes. Supporting multiple providers reduces dependency on any one. |
| Customers don't trust AI-written code | Medium | Full transparency (every action in their tools). Start with advisory mode option. Build trust gradually. |
| Market moves fast, competitors ship similar | Medium | Ship fast. First-mover in the "multi-agent team as SaaS" niche. |
| Hard to debug when agents go wrong | Medium | Detailed execution state per task. Replay capability (re-run a task with same context). |
| Runaway LLM costs | Medium | Per-task and per-day cost ceilings. Pre-call cost estimation. Guardrails prevent oversized output. |

---

## 13. Rollout Plan

### Phase 1 — MVP (current)
- ✅ Monorepo with Bun workspaces (6 packages)
- ✅ CompanyConfig data model (YAML)
- ✅ GitHub adapter (idempotent ops)
- ✅ Linear adapter (via `@floor-agents/task` factory)
- ✅ Anthropic adapter (tool use)
- ✅ Context builder v1 (keyword matching, token budget)
- ✅ Orchestrator (10-step state machine, crash recovery)
- ✅ Guardrails (file count/size, blocked paths, path traversal)
- ✅ Cost tracking (per-task, per-day limits)
- ✅ Backend Dev agent role with prompt template
- Single tenant (internal dogfooding)
- Goal: Linear issue → code → GitHub PR → Linear update

### Phase 2 — The Team + Committee
- ✅ CTO agent (PR review via Claude Code)
- ✅ Multi-agent review loop (dev writes, CTO reviews, max 3 cycles)
- ✅ Committee mode (parallel voting, majority tally)
- ✅ External agents via WebSocket gateway (auth, reconnection, REST fallback)
- ✅ GitHub Discussions sync
- ✅ Context builder v2 (import tracing)
- ✅ Additional LLM providers: OpenAI, Gemini, LM Studio, Claude Code
- ✅ Additional task adapters: Things 3, GitHub Issues
- PM agent (task decomposition)
- QA agent (test writing)
- Frontend Dev agent
- Workflow engine (state machine execution, dependencies, revision loops)
- Web dashboard for config

### Phase 3 — Multi-Tenant SaaS
- Customer onboarding flow
- Multi-tenancy isolation
- Secrets management
- Usage tracking and billing
- Multiple customer projects

### Phase 4 — Platform
- GitLab adapter
- Jira adapter
- Additional LLM providers (Mistral, Ollama)
- Custom agent roles (customer-defined)
- Context builder v3 (embeddings)
- DevOps agent
- Cost optimization dashboard
- Agent performance analytics

---

## 14. What's Next

- PM agent (task decomposition for complex issues)
- QA agent (automated test writing)
- Workflow engine (state machine with dependency resolution)
- Web dashboard for config and monitoring

See [Next Steps](./next-steps.md) for the full prioritized list.
