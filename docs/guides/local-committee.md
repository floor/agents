# Local Committee — Claude Code + Codex + Antigravity

Run a technical committee entirely from **local CLI/IDE tools** — no cloud API keys, no Linear/GitHub required. Each agent reviews an RFC markdown file from disk and votes; the round is **event-driven** end to end.

This is the all-local variant of [Committee Mode](./committee.md). Where committee mode dispatches cloud LLM adapters and triggers off Linear labels, this setup wires the actual tools a developer already runs:

| Agent | Tool | Transport | Auth |
|-------|------|-----------|------|
| **claude** | Claude Code CLI | internal — orchestrator spawns `claude -p` | the CLI's own login |
| **codex** | Codex CLI | external — gateway → `codex exec` | the CLI's own login |
| **antigravity** | Antigravity IDE (Gemini) | external — gateway ⇄ files ⇄ MCP | the IDE's own login |

> **Worked example:** on 2026-06-13 this committee reviewed `RFC-013: Spatial Navigation Model` and returned **REJECTED 2-1** (Claude APPROVE, Codex REJECT, Antigravity REJECT) — each through its real tool, $0.75, no cloud keys.

---

## Why Antigravity needs a special bridge

Codex is easy: it's a headless CLI, so a [gateway](../gateway.md) client just runs `codex exec` and returns the output. Antigravity is not — and its constraints dictate the whole design:

1. **No headless mode.** Antigravity is a GUI IDE; its agent (Cascade, Gemini) only acts inside the app.
2. **No MCP sampling or autonomous notifications.** An MCP server *cannot* push work to Antigravity and make it act — it only exposes tools the agent calls.
3. **It cycles its own background-task processes.** A long-lived gateway connection started *inside* Antigravity gets killed and restarted, which thrashes the connection.
4. **It wakes on background-task stdout.** When a background task Antigravity is running prints a line, Antigravity's agent wakes and can act on it.

So the bridge is split into three cooperating pieces:

```
[ outside Antigravity — persistent ]            [ inside Antigravity — cycle-tolerant ]
  antigravity-relay.ts                            antigravity-notify.ts
  (gateway client, holds the slot)                (stateless; prints NEW_REVIEW)
        │  gateway assigns                                │ wakes Antigravity
        ▼                                                 ▼
   ~/.floor-committee/pending/  ◄──── scans ────  Antigravity agent (Gemini)
        ▲                                                 │ get_pending_review
        │ forwards vote                                   ▼
   ~/.floor-committee/results/  ◄──── submit_vote ──  antigravity-mcp.ts (file-backed MCP)
        │
        └──► relay forwards the vote back to the gateway → committee tallies
```

- **`scripts/antigravity-relay.ts`** — the persistent gateway client. Runs **outside** Antigravity (the round harness or pm2 owns it). Receives assignments → writes `~/.floor-committee/pending/<id>.json`; polls `~/.floor-committee/results/` → forwards votes to the gateway.
- **`scripts/antigravity-notify.ts`** — a **stateless** wake notifier, run as a background task **inside** Antigravity. Scans `pending/`, prints `NEW_REVIEW <id>` to stdout (which wakes Antigravity). A per-review `.announced` marker (written before printing) guarantees one wake per review even if Antigravity kills/restarts it — no death-loop, no duplicate reviews.
- **`scripts/antigravity-mcp.ts`** — a **file-backed** MCP server (holds no gateway connection). `get_pending_review` reads `pending/`; `submit_vote` writes `results/`. Registered in Antigravity at `~/.gemini/config/mcp_config.json`.

The relay and MCP server are decoupled through the filesystem, so the MCP server is race-free and safe to lazy-spawn, and the relay's lifecycle is independent of Antigravity's process churn.

---

## Setup

### 1. Project config

Central layout under `~/Code/floor/.agents/` (one folder per project). The trio config marks Codex and Antigravity `external: true`:

```yaml
# ~/Code/floor/.agents/projects/vlist/agents.yaml
agents:
  - id: claude
    name: "Claude"
    promptTemplate: "/Users/you/Code/floor/.agents/prompts/claude-reviewer.md"
    llm: { provider: claude-code, model: opus }
    capabilities: [read_code, review_rfc, vote]

  - id: codex
    name: "Codex"
    external: true
    promptTemplate: "/Users/you/Code/floor/.agents/prompts/codex-reviewer.md"
    llm: { provider: openai, model: local }   # provider unused for external agents
    capabilities: [review_rfc, vote]

  - id: antigravity
    name: "Antigravity"
    external: true
    promptTemplate: "/Users/you/Code/floor/.agents/prompts/antigravity-reviewer.md"
    llm: { provider: gemini, model: local }    # provider unused for external agents
    capabilities: [review_rfc, vote]
```

Each agent reviews through its **own** persona (`promptTemplate`) — Claude grounds in the codebase, Codex weighs migration risk, Antigravity reasons from browser internals. (External agents get their own persona too; this was a fix — previously they shared one generic prompt.)

No cloud keys are needed: `provider` for external agents is ignored (they run via the gateway), and the orchestrator no longer requires an API key for them.

### 2. Register the Antigravity MCP server

Antigravity (IDE/CLI) reads MCP config from `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "floor-committee": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["/Users/you/Code/floor/agents/scripts/antigravity-mcp.ts"]
    }
  }
}
```

Use an absolute `bun` path — Antigravity spawns MCP servers with a minimal `PATH`. After saving, refresh MCP servers in Antigravity; `floor-committee` should appear with `get_pending_review` and `submit_vote`.

### 3. Arm Antigravity (once)

In Antigravity, start the notifier as a background task and give it a standing rule:

> Run this as a background task and keep it alive:
> `bun /Users/you/Code/floor/agents/scripts/antigravity-notify.ts`
>
> Whenever it prints a line starting with `NEW_REVIEW`, immediately: call `get_pending_review` on `floor-committee`, review the RFC from your browser-engine perspective, then call `submit_vote` with the `taskId` and your review ending in `VOTE: APPROVE` or `VOTE: REJECT`.

Antigravity is now standing by for every future round.

---

## Running a round

One command spins up the gateway, the Codex bridge, and the Antigravity relay (the harness auto-spawns the relay whenever `antigravity` is in `AGENTS`):

```bash
cd ~/Code/floor/agents
RFC_FILE=~/Code/floor/vlist.io/docs/rfcs/RFC-013-Spatial-Navigation-Model.md \
CODEX_CWD=~/Code/floor/vlist \
AGENTS=claude,codex,antigravity \
bun scripts/committee-run.ts
```

| Env | Meaning |
|-----|---------|
| `RFC_FILE` | the RFC markdown to review (frontmatter stripped, `# heading` → title) |
| `CODEX_CWD` | repo the reviewers read for grounding (Claude + Codex run here) |
| `AGENTS` | which committee agents to include (default `claude,codex`) |
| `GATEWAY_PORT` | gateway port (default `3199`) |
| `EXTERNAL_TIMEOUT_MS` | how long to wait for an external vote (default `600000`) |

Flow: Claude reviews internally; Codex is pushed over the gateway and runs `codex exec --sandbox read-only`; the relay drops a pending file → Antigravity's notifier wakes it → it reviews and submits → the relay forwards the vote. Votes tally by simple majority.

### Daemon path (pm2)

For a long-running fleet, `~/Code/floor/.agents/ecosystem.config.cjs` reads `fleet.json` and starts, per enabled project: the orchestrator, the `codex-<project>` bridge, and the `antigravity-<project>` relay (the relay lives here precisely because it must run *outside* Antigravity). Antigravity still runs `antigravity-notify.ts` itself.

---

## File protocol

The relay and MCP server communicate through `~/.floor-committee/`:

```
~/.floor-committee/
├── pending/
│   ├── <id>.json          # the TaskAssignment (relay writes, MCP reads)
│   └── <id>.announced     # notifier dedup marker (one wake per review)
└── results/
    └── <id>.json          # { taskId, content } (MCP writes, relay forwards + deletes)
```

`<id>` is the task id with non-`[A-Za-z0-9._-]` chars replaced by `_`. `submit_vote` writes results atomically (tmp + rename); the relay **polls** `results/` every 400ms (not `fs.watch` — it misses atomic renames on macOS).

---

## Troubleshooting

- **Antigravity connects then disconnects in a loop** — you're running a gateway client *inside* Antigravity (e.g. an old single-process `antigravity-agent.ts`). Antigravity cycles processes; the gateway client must be the **relay**, run outside. Inside Antigravity, run only `antigravity-notify.ts`.
- **`get_pending_review` returns "No review pending"** — the relay isn't running or isn't connected to the round's gateway. Start a round (which spawns the relay) or check `GATEWAY_URL`/port.
- **Vote recorded but round times out** — the relay isn't polling/forwarding (check it's alive and on the same port). A stale leftover file in `pending/`/`results/` can also shadow a new review; clear `~/.floor-committee/` between manual tests.
- **Duplicate `antigravity` rejected by gateway** — two gateway clients claimed the slot (e.g. relay + a leftover bridge). Only one process may register as `antigravity`.
- **Antigravity re-reviews the same RFC** — the `.announced` marker was lost. The relay deletes it on successful forward; don't hand-delete `pending/` mid-review.

---

## See also

- [Committee Mode](./committee.md) — the Linear-triggered, cloud-adapter variant
- [Agent Gateway](../gateway.md) — WebSocket protocol, REST fallback, building custom agents
- [Zero-Cost Committee](./zero-cost-committee.md) — local models for $0/review
