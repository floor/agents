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

## Setting up the Telegram channel

It needs a **bot**, not a user account: the code talks to the Bot API
(`api.telegram.org/bot<token>/`), while a Telegram user account speaks MTProto — a
different protocol, and automating one risks a ban. One bot serves every agent; the
speaker is a text prefix (`🤖 Codex:`), so there is no need for a bot per agent.

1. **Create the bot.** Message @BotFather → `/newbot` → copy the token into
   `TELEGRAM_BOT_TOKEN`.
2. **Pick the chat.** A private 1:1 chat with the bot is the secure default: Telegram sets
   `chat.id === from.id` there, so only you can steer the run and no allowlist is needed.
   Use a group only when several people must watch.
3. **Find the chat id.** Send the bot any message, then:

   ```sh
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
   ```

   Read `message.chat.id` into `TELEGRAM_CHAT_ID`. Group ids are negative; supergroups
   start `-100`.
4. **For a group only — two steps that are easy to miss:**
   - BotFather → `/setprivacy` → **Disable**. Bots default to privacy mode ON in groups,
     where they receive only messages starting with `/`, replying to the bot, or
     @mentioning it. Leave it on and `drainHumanMessages` returns nothing while every
     other check reports healthy.
   - Set `TELEGRAM_ALLOW_FROM` to the operator user ids, or the group fails closed and
     hears no one. Run once and the log names whoever was ignored:
     `[telegram] ignored input from user 12345 in chat -100… — not in allowFrom`.

```sh
TELEGRAM_BOT_TOKEN=…
TELEGRAM_CHAT_ID=…
TELEGRAM_ALLOW_FROM=12345,67890   # group only; omit for a private chat
```

**What leaves the machine:** each turn's `summarize()` output — 600 characters of agent
review text, which routinely quotes file paths and code from a private repo. It is stored
in Telegram's cloud, and group chats are never end-to-end encrypted. The RFC body and the
system prompts are not sent. Omit both variables and the committee scripts run
console-only.

## First proof (next increment)

One small, test-backed vlist task: orchestrator agent runs `inspect_repo` →
`execute` (dev→test→PR loop) → `verify` (must be green) → opens a PR → stops at the
human-approval gate. Success = a green PR opened unattended; the human touches only
approve/merge. Failure is reported by the test suite, not by the agent.
