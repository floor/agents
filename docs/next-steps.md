# Next Steps

Updated May 19, 2026.

---

## Completed

- ~~Fix provider routing~~ — orchestrator correctly routes through `getLLMAdapter(agent.llm.provider)`
- ~~Split the orchestrator~~ (FLO-16) — 11 focused modules
- ~~Native agent execution with git worktree~~ (FLO-15) — Claude Code edits in worktrees
- ~~Committee mode~~ — parallel voting, majority tally, GitHub Discussions sync
- ~~External agents~~ — WebSocket gateway with auth, validation, reconnection, REST fallback
- ~~Gateway client~~ — auto-reconnect client with exponential backoff
- ~~Codex agent script~~ — standalone external agent connecting via gateway
- ~~Context builder v2~~ — import tracing for better file selection
- ~~Additional providers~~ — OpenAI, Gemini, LM Studio, Claude Code adapters
- ~~Additional task adapters~~ — Things 3, GitHub Issues
- ~~GitHub Discussions sync~~ — vote results posted to linked discussions

## Up Next

### 1. Linear rate limiting and polling interval

**Priority:** High

Current: 5-second polling, no backoff on errors. Hit 5000 req/hr limit during sprint 4. Fix:
- Increase polling interval to 30 seconds
- Add exponential backoff on errors (cap at 5 min)
- Parse `Retry-After` header when rate limited

### 2. PM agent (task decomposition)

**Priority:** Medium — depends on workflow engine.
**Status:** Implemented in `packages/orchestrator/src/pm-agent.ts` (`runPMAgent`), **not yet wired into the orchestrator.**

Complex tasks timeout or produce incomplete results. The PM agent assesses an issue and decomposes it into independent backend/frontend sub-tasks (via `create_subtask` / `subtasks_done` tool calls) before assigning to dev agents. The implementation exists; the remaining work is integration into `createOrchestrator`.

### 3. Context builder hints for native agents

**Priority:** Low — native mode works without this, it's a quality improvement.

Only include file paths as hints (not full content — Claude Code reads them itself). Include import graph from the v2 file selector.

### 4. Workflow engine

**Priority:** Medium
**Status:** Implemented in `packages/orchestrator/src/workflow-engine.ts` (`WorkflowEngine`), **not yet wired into the orchestrator.**

The `workflow:` config (states, transitions, cycle limits) is currently parsed and validated but **not executed at runtime** — the live `createOrchestrator` uses a simpler hardcoded dev → review flow. `WorkflowEngine` is the config-driven state machine that would execute it: trigger matching, agent resolution, status transitions, and the "max review cycles → Needs Human" rule. Remaining work: wire it into `createOrchestrator`.

> **Dogfooding note.** Both `pm-agent.ts` and `workflow-engine.ts` were built on the
> `agent/d6bf3bd8-implement-configurable-workflow-engine-pm-dev-cto` branch — i.e. Floor
> Agents implementing its *own* orchestration engine. The code landed and was merged, but
> the final integration was deferred. They are kept deliberately as the basis for this
> work — not dead code. (A dependency scan will flag them as orphan modules; that's expected.)

### 5. Provider registry (pluggable LLM adapters)

**Priority:** Medium

Today the provider → adapter mapping is hardcoded (`src/main.ts` does
`if (requiredProviders.has('anthropic')) createAnthropicAdapter()…`), so the set of LLM
providers is fixed at the five built-ins (anthropic, openai, gemini, lmstudio, claude-code).

Replace the switch with a **registry**: built-in adapters register by name, and consumers
can `registerProvider("mycorp-llm", createMyAdapter)` to add or override any provider
without forking — an agent's `provider:` field then resolves to a registered factory. The
`LLMAdapter` interface already exists in `@floor-agents/core`, so this is mostly wiring.

Keep the built-ins **bundled** (they're tiny and dependency-free — native `fetch` /
`Bun.spawn` — so there's nothing to gain by splitting them into separate packages). The goal
is *extensibility*, not slimming: built-in ≠ hardcoded. Completes the "vendor-agnostic AI"
design goal and lets library consumers (e.g. the interactive front-end) register only the
providers they use.

---

## Sprint Summary

| Sprint | Model | Tasks | PRs | Merged | Key Outcome |
|:------:|-------|:-----:|:---:|:------:|-------------|
| 1 | Gemma (LM Studio) | 5 | 5 | 2 | Pipeline works, code needs cleanup |
| 2 | Claude Code Sonnet (API) | 5 | 5 | 5 | Production quality, all merged |
| 3 | Claude Code Sonnet (CLI) | 5 | 1 | 1 | Adapter mismatch exposed |
| 4 | Claude Code (native worktree) | 5 | 0 | 0 | Editing works, push fails |

## Architecture Status

```
packages/
├── core/              ✅ Stable
├── anthropic/         ✅ Stable
├── claude-code/       ✅ Stable (strips API key, uses Max plan)
├── lmstudio/          ✅ Stable
├── openai/            ✅ Stable
├── gemini/            ✅ Created by AI agents (sprint 2)
├── github/            ✅ Stable (branch protection, Discussions sync)
├── task/              ✅ Linear + Things + GitHub Issues
├── context-builder/   ✅ v2 import tracing (created by AI agents)
├── orchestrator/      ✅ Dev mode + committee mode
│   ├── orchestrator.ts              — dev watch loop
│   ├── committee-orchestrator.ts    — committee watch loop
│   ├── committee-pipeline.ts        — parallel review, vote tally, sync
│   ├── pipeline.ts                  — task execution flow
│   ├── native-runner.ts             — worktree dev + review
│   ├── llm-runner.ts                — tool use loop
│   ├── guardrails.ts                — output validation
│   ├── cost-tracker.ts              — spending limits
│   ├── state-store.ts               — crash recovery
│   └── ...
└── gateway/           ✅ WebSocket + REST, auth, reconnection
    ├── gateway.ts     — server (auth, validation, task re-queue)
    ├── client.ts      — agent client (auto-reconnect, exponential backoff)
    └── types.ts       — protocol types + message validation
```
