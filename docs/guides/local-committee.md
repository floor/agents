# Local Committee — Claude Code + Codex + Grok

Run a technical committee entirely from **local CLI tools** — no cloud API keys, no Linear/GitHub required. Each agent reviews an RFC markdown file from disk and votes; the round is **event-driven** end to end.

This is the all-local variant of [Committee Mode](./committee.md). Where committee mode dispatches cloud LLM adapters and triggers off Linear labels, this setup wires the actual tools a developer already runs:

| Agent | Tool | Transport | Auth |
|-------|------|-----------|------|
| **claude** | Claude Code CLI | internal — orchestrator spawns `claude -p` | the CLI's own login |
| **codex** | Codex CLI | external — gateway → `codex exec` | the CLI's own login |
| **grok** | Grok CLI | external — gateway → `grok --prompt-file` | the CLI's own login |

> **Worked example:** on 2026-06-13 this committee reviewed `RFC-013: Spatial Navigation Model` — each agent through its real local tool, no cloud keys, votes tallied by strict majority.

All three members are **headless CLIs**, which is the whole point: a CLI is a process the gateway fully controls — assign a task, run the binary, capture stdout, record the vote. There is no GUI session to keep warm, nothing to poll, and no human relaying messages. (Antigravity, a GUI IDE, was the original third seat; it cannot participate unattended and is now parked — see [Appendix: why Antigravity is parked](#appendix-why-antigravity-is-parked).)

---

## Why every member is a CLI

The committee is event-driven: the gateway emits a review event, and each member must **act when the event arrives**. A headless CLI does this natively:

```
gateway assigns task ──► external-agent bridge runs the CLI ──► captures stdout ──► posts vote
```

- **`scripts/codex-agent.ts`** — gateway client. On assignment, runs `codex exec --sandbox read-only` against the repo and returns the last message as the vote.
- **`scripts/grok-agent.ts`** — gateway client. On assignment, writes the prompt to a temp file and runs `grok --prompt-file … --output-format plain --permission-mode dontAsk --sandbox read-only`, returning stdout as the vote.

Both are the same ~80-line pattern: connect to the gateway with `capabilities: ['review_rfc', 'vote']`, implement `onTask`, run the local binary, return the review text (ending in `VOTE: APPROVE` / `VOTE: REJECT`). Adding a fourth CLI member is a copy of either file plus an entry in the project config.

This is why the loop is robust: there is no "wake" problem. The bridge process is always connected; the CLI is spawned on demand and exits when done.

---

## Setup

### 1. Project config

The committee lives in the manifest of the project it reviews, `.agents/agents.yaml`, beside the agents that implement: its members are the agents with the `vote` capability. The scripts read `<CODEX_CWD>/.agents/agents.yaml`; set `COMMITTEE_CONFIG` to use another file. External members are marked `external: true`:

```yaml
# <repo>/.agents/agents.yaml — prompt paths resolve relative to this file
agents:
  - id: claude
    name: "Claude"
    promptTemplate: "../../agents/agents/claude-reviewer.md"
    llm: { provider: claude-code, model: opus }
    capabilities: [read_code, review_rfc, vote]

  - id: codex
    name: "Codex"
    external: true
    promptTemplate: "../../agents/agents/codex-reviewer.md"
    llm: { provider: openai, model: local }   # provider unused for external agents
    capabilities: [review_rfc, vote]

  - id: grok
    name: "Grok"
    external: true
    promptTemplate: "../../agents/agents/grok-reviewer.md"
    llm: { provider: cursor, model: local }   # provider unused for external agents
    capabilities: [review_rfc, vote]
```

The reviewer prompts ship in this repository under `agents/`.

Each agent reviews through its **own** persona (`promptTemplate`) — Claude grounds in the codebase, Codex weighs migration risk, Grok reasons from first principles and distinguishes bounded from unbounded problems. Distinct personas are deliberate: they give the panel genuine perspective diversity instead of three takes on the same prior.

No cloud keys are needed: `provider` for external agents is ignored (they run via the gateway), and the orchestrator no longer requires an API key for them.

### 2. Log in to the CLIs

Each member authenticates with its own tool — once, on your machine:

```bash
claude   # Claude Code: already logged in if you use the CLI
codex    # Codex: its own login
grok login --oauth          # Grok: signs in via auth.x.ai (X / xAI account)
grok models                 # verify: should NOT say "You are not authenticated"
```

> **Grok model note.** The grok.com `grok-build` model (the CLI default) **rejects the `reasoningEffort` parameter** — passing `--effort` returns HTTP 400. The bridge therefore omits `--effort` by default; only set `GROK_EFFORT` for a model that supports it.

That's the entire external-member setup — no MCP server, no relay, no background task. The bridge is spawned by the round harness.

---

## Running a round

One command spins up the gateway and the external bridges (the harness auto-spawns a bridge for each external agent in `AGENTS`):

```bash
cd ~/Code/floor/agents
RFC_FILE=~/Code/floor/vlist.io/docs/rfcs/RFC-013-Spatial-Navigation-Model.md \
CODEX_CWD=~/Code/floor/vlist \
AGENTS=claude,codex,grok \
bun scripts/committee-run.ts
```

| Env | Meaning |
|-----|---------|
| `RFC_FILE` | the RFC markdown to review (frontmatter stripped, `# heading` → title) |
| `CODEX_CWD` | repo the reviewers read for grounding (all members run here) |
| `AGENTS` | which committee agents to include (default `claude,codex,grok`) |
| `GATEWAY_PORT` | gateway port (default `3199`) |
| `EXTERNAL_TIMEOUT_MS` | how long to wait for an external vote (default `600000`) |
| `GROK_MODEL` / `GROK_EFFORT` / `GROK_SANDBOX` | optional Grok overrides (model id, effort, sandbox profile) |

Flow: Claude reviews internally; Codex and Grok are each pushed over the gateway and run their CLI headless against `CODEX_CWD` in a **read-only** sandbox; each returns its review and the gateway records the vote. Votes tally by **strict majority** (a tie or a missing vote does not pass).

### Daemon path (pm2)

A long-running fleet would start, per project, the orchestrator and one bridge per external member (`codex-<project>`, `grok-<project>`). Because the bridges are plain CLIs, the daemon owns their whole lifecycle — there is no out-of-band process to coordinate. The earlier central launcher under `~/Code/floor/.agents/` is retired; a per-project pm2 config has not been written yet.

---

## Troubleshooting

- **External agent connects then the round times out** — the CLI isn't authenticated (run its login) or the review exceeded `EXTERNAL_TIMEOUT_MS`. Check the bridge's inherited stdout in the run log for the CLI's own error.
- **Grok 400 `does not support parameter reasoningEffort`** — you set `GROK_EFFORT` (or an old build defaulted it) against `grok-build`. Unset it.
- **Duplicate agent id rejected by gateway** — two bridges claimed the same slot (e.g. a leftover pm2 process plus the round harness). Only one process may register per agent id.
- **Empty review / no `VOTE:` line** — the CLI printed to stderr, not stdout, or produced tool noise. Codex uses `--output-last-message`; Grok uses `--output-format plain`. Check the bridge captured the final message.

---

## See also

- [Committee Mode](./committee.md) — the Linear-triggered, cloud-adapter variant
- [Agent Gateway](../gateway.md) — WebSocket protocol, REST fallback, building custom agents
- [Zero-Cost Committee](./zero-cost-committee.md) — local models for $0/review

---

## Appendix: why Antigravity is parked

Antigravity (the Gemini-backed GUI IDE) was the original third seat. We invested in a three-part file-backed bridge to let it participate, but it **cannot vote unattended**, which breaks the event-driven contract. The reasons — confirmed directly by Antigravity about its own internals on 2026-06-13:

1. **No external push verb.** The `agentapi` binary (`language_server agentapi …`, reachable at the LS's local port via `ANTIGRAVITY_LS_ADDRESS`) exposes no supported command to inject a prompt or start a Cascade turn from outside.
2. **Background-task stdout does not wake the agent.** A running task's stdout is appended to Cascade's transcript silently. Cascade only resumes on: (a) a background task **completing**, (b) a **native scheduled notification** (`/schedule`), or (c) a **user message**. So an always-alive notifier printing `NEW_REVIEW` is never seen until something else wakes the agent — which is exactly why two full committee runs timed out to abstain with every process alive.
3. **The only unattended wake is the native scheduled poll.** `/schedule` fires a high-priority notification on a cron that genuinely wakes Cascade. That's polling, not push — it contradicts the pure event-driven design, and was declined.
4. **Rules persist via an MCP instructions file.** `~/.gemini/antigravity/mcp/<server>/instructions.md` is auto-injected into every session where that MCP server is active — the right place for a standing rule, but it only matters once something wakes the agent.

**Conclusion:** a committee member must act when the event arrives. A headless CLI does; a GUI agent with no external push does not. Grok (a CLI) replaced Antigravity in the third seat. The Antigravity bridge scripts (`antigravity-relay.ts`, `antigravity-notify.ts`, `antigravity-mcp.ts`) remain in `scripts/` for reference and for any future Antigravity build that exposes a real push/trigger, and the `antigravity` agent stays defined (but out of the default `AGENTS`) in the project config.
