# The Orchestrator Agent

> **Status (2026-09-17):** landed + tested (261 suite green, typecheck clean):
> - `orchestrator-agent.ts` — reasoning loop + the two guardrails (objective-verification, ground-before-act).
> - `team-channel.ts` + `deliberation.ts` — the shared bus + channel-aware committee core; both committee scripts run on it.
> - `telegram-channel.ts` — zero-dep Telegram `TeamChannel`. Committee scripts auto-use it when
>   `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set:
>   ```
>   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… DISCUSSION=117 bun scripts/discussion-committee.ts
>   ```
>   Turns stream to the chat; messages you type are folded into the next round; approvals use inline buttons.
>   In a **group** chat, also set `TELEGRAM_ALLOW_FROM` to the operator user ids (comma-separated):
>   a group update carries the same chat id for every member, so the channel authorizes the message
>   *author*, and with no allowlist it trusts only the bot's private chat. Human input is folded
>   verbatim into the agents' next prompt, so this list is who can steer a run.
>
> **Not yet done (the real autonomy proof):** wire the orchestrator agent's *real* tools
> (inspect, `verify` via `bun test`, `execute` via `executeTask`, `request_human_approval`) and run
> it on one small test-backed task → a green PR opened unattended. The pieces are built + unit-tested;
> they have not been exercised together on a live task.

## Why

Floor Agents already has the *workers*: `executeTask` (dev → commit → PR → review
cycle), the committee (`executeCommitteeReview`), the gateway, guardrails, cost
tracking, crash-recovery state. What it lacked was the *conductor* — the reasoning
that decides what to call when, grounds before acting, interprets results, and only
finishes when the work objectively passes. In the RFC-013 pilot a human (the
interactive assistant) played that role by hand, which is why it wasn't autonomous.

The orchestrator agent **is that role, made into an agent**: an LLM reasoning loop
whose tools are the engine capabilities, with guardrails that make it trustworthy to
run unattended.

## Architecture

It replaces the brain of the dumb watch-loop in `orchestrator.ts` (today:
`watchIssues → resolveAgent → executeTask`) with a reasoning loop built on the
existing `runToolUseLoop` (which already takes `tools` + a `toolHandler`).

```
observe state → decide (LLM) → call a tool → verify (objective) → escalate or continue
```

### Tool surface (mostly already exists)

| Tool | Backed by | Status |
|------|-----------|--------|
| `inspect_repo` | bash / read | exists |
| `decompose` | `pm-agent.ts` runPMAgent | built, unwired |
| `review` | `committee-pipeline` | exists |
| `decide` | `decision-committee.ts` | built |
| `execute` | `pipeline.ts` executeTask | exists |
| `verify` | `native-runner` (runs `bun test`+`typecheck`) | exists inside dev → expose as a gate |
| `escalate` / transitions | `workflow-engine.ts` | built, unwired |
| `request_human_approval` | — | net-new |
| `report` | `taskAdapter.addComment` | exists |

### The five guardrails (the actual product)

1. **Objective verification** — the agent cannot declare "done"; only a passing
   `verify` (tests/typecheck/build green) can let it finish. A code change
   invalidates a prior pass, forcing a re-verify. *(Built first — it's the single
   most important defense; it's what would have stopped the assistant narrating
   false success in the pilot.)*
2. **Ground-before-act** — an `act` tool is refused until the agent has inspected.
   *(Built first.)*
3. **Human approval for irreversible/outward actions** — commit-to-main, PR merge,
   public post, delete. (`executeTask` already stops at PR *creation*, never merge.)
4. **Escalation** — hung committee / max review cycles / ambiguity → human or the
   decision-committee. (`MAX_REVIEW_CYCLES → Needs human` already exists.)
5. **Budget + step caps** — `cost-tracker` budgets + an orchestration step cap
   (mirroring `MAX_TOOL_ROUNDS` in `llm-runner`).

Guardrails 1 and 2 are implemented as a **pure function** (`applyGuards`) so they're
directly unit-testable without an LLM, and enforced in the `toolHandler` wrapper —
the model physically cannot bypass them, regardless of what it says.

## First proof (next increment)

One small, test-backed vlist task: orchestrator agent runs `inspect_repo` →
`execute` (dev→test→PR loop) → `verify` (must be green) → opens a PR → stops at the
human-approval gate. Success = a green PR opened unattended; the human touches only
approve/merge. Failure is reported by the test suite, not by the agent.
