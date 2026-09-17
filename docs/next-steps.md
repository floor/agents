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

### 6. Harden the team-channel / orchestrator-agent stack

**Priority:** High for the channel items.
**Status:** Reviewed Sep 17, 2026 — 261 tests green, typecheck clean. `runDeliberation` and
`createTelegramChannel` are in production use by both committee scripts;
`createOrchestratorAgent` has no callers yet.

- ~~**The Telegram allowlist checked the chat, not the sender**~~ — fixed Sep 17, 2026.
  Both checks read the *chat* id, and `allowFrom` defaulted to `[chatId]`, so in the
  intended group deployment every member could interject and tap Approve. Since human
  input is folded verbatim into the agents' next prompt and the agents hold `Bash` on a
  private repo, that was a live injection path. `allowFrom` now authorizes the message
  author, set from `TELEGRAM_ALLOW_FROM`; with no allowlist only the bot's private chat
  is trusted, so a group fails closed until its operators are named.
- ~~**The channel was unguarded on the critical path**~~ — fixed Sep 17, 2026. A Telegram
  blip used to abort a paid multi-round run and lose every completed round. Channel calls
  now go through `safely()` and report via `onChannelError` (default `console.warn`).
  `onTurn` is deliberately still fatal: the channel is a window, but `onTurn` persists the
  durable record and must not fail quietly. Both halves are covered by tests.
- ~~**Telegram failures were silent**~~ — fixed Sep 17, 2026. `post()` now logs a rejected
  send, and an undelivered approval prompt fails closed immediately instead of blocking
  for the full 30-minute timeout on a button that never arrived. Both committee scripts
  now pass a real `log`; the library default is still a no-op for embedders.
- **Cost enforcement — partly done.** Fixed Sep 17, 2026: both scripts now gate on
  `company.costs.maxCostPerTask` at each round boundary inside `converged`, so a run stops
  when it has spent its allowance. Still open: external CLI agents record `costUsd: 0`, so
  the total is knowingly understated — unknown cost is not distinguished from zero — and
  the tracker is in-memory per process, so nothing is enforced across runs.
- **Verification is a boolean, not a revision.** `GuardState.lastVerifyPassed` is
  invalidated only by an `act` routed through the same handler, so an out-of-band change
  leaves a stale pass. (The concurrency half of this — overlapping `act`/`verify` — was
  fixed by serializing tool handlers in `llm-runner.ts`, with a regression test.)
- **The `done` guard blocks a tool, not termination.** `runToolUseLoop` exits whenever
  `stopReason !== 'tool_use'` (`llm-runner.ts:68`) without consulting guard state, so a
  model can simply stop calling tools and still return a "tests pass" narration. Callers
  must check `result.guard.lastVerifyPassed`; none do yet.
- **`ToolKind` is self-declared.** A mutating tool registered as `inspect` or `report`
  bypasses both guardrails, and nothing validates the classification.
- **`awaitDecision` has no production caller**, so guardrail 3 (human approval for
  irreversible actions) is unreachable despite the inline-button UX existing.
- **`MAX_ROUNDS` parses without validation** (`discussion-committee.ts`); a non-numeric
  value yields `NaN`, runs zero rounds, and posts an empty consensus table to the public
  GitHub thread.

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
