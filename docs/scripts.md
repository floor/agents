# Scripts

Runnable helpers in `scripts/`. They are not part of any package — run them directly with `bun`. The committee scripts implement the all-local trio described in the [Local Committee guide](./guides/local-committee.md); this page is the code-level reference for each.

| Script | Role | Runs |
|--------|------|------|
| [`committee-run.ts`](#committee-runts) | Review an RFC file with the committee | by you (per round) |
| [`codex-agent.ts`](#codex-agentts) | Codex gateway bridge → `codex exec` | by `committee-run` / pm2 |
| [`antigravity-relay.ts`](#antigravity-relayts) | Persistent Antigravity gateway client | by `committee-run` / pm2 |
| [`antigravity-notify.ts`](#antigravity-notifyts) | Stateless wake notifier | by Antigravity (background task) |
| [`antigravity-mcp.ts`](#antigravity-mcpts) | File-backed MCP server | by Antigravity (MCP) |
| [`committee-smoke.ts`](#committee-smokets) | 2-way smoke test | by you (manual) |
| [`gateway-listen.ts`](#gateway-listents) | Bare gateway diagnostic | by you (manual) |

---

## committee-run.ts

Runs one committee review on an RFC **markdown file**, without `main.ts`, Linear, or GitHub. It stands up a real [gateway](./gateway.md), spawns the external-agent bridges it needs (Codex bridge, Antigravity relay), reads the RFC, runs `executeCommitteeReview`, prints the votes, and tears everything down.

```bash
RFC_FILE=~/Code/floor/vlist.io/docs/rfcs/RFC-013.md \
CODEX_CWD=~/Code/floor/vlist \
AGENTS=claude,codex,antigravity \
bun scripts/committee-run.ts
```

| Env | Default | Meaning |
|-----|---------|---------|
| `RFC_FILE` | — (required) | RFC markdown; YAML frontmatter stripped, first `# heading` → title |
| `CODEX_CWD` | `~/Code/floor/vlist` | repo the reviewers read for grounding |
| `AGENTS` | `claude,codex` | comma-separated committee agent ids to include |
| `GATEWAY_PORT` | `3199` | gateway port |
| `EXTERNAL_TIMEOUT_MS` | `600000` | per-external-agent vote timeout |

- Loads `~/Code/floor/.agents/projects/vlist/agents.yaml`; filters to agents with the `vote` capability that are listed in `AGENTS`.
- Claude (`claude-code`) is wired via `createClaudeCodeAdapter` with read-only tools (`Read/Glob/Grep/Bash`), `cwd = CODEX_CWD`.
- Spawns `codex-agent.ts` if `codex` is included, and `antigravity-relay.ts` if `antigravity` is included (the relay must run outside Antigravity).
- `contextBuilder`/`stateStore` are unused by `executeCommitteeReview` and passed as stubs; `taskAdapter` is an in-memory stub that just logs the committee's posts.
- Exits 0 after printing the tally; kills the bridges and stops the gateway.

## codex-agent.ts

Gateway client for **Codex**. Registers as agent `codex`, and on each assignment runs the local Codex CLI in a read-only sandbox, returning the final message as the review.

```bash
GATEWAY_URL=ws://localhost:3199 CODEX_CWD=~/Code/floor/vlist bun scripts/codex-agent.ts
```

| Env | Default | Meaning |
|-----|---------|---------|
| `GATEWAY_URL` | `ws://localhost:3199` | gateway to connect to |
| `GATEWAY_TOKEN` | — | gateway auth token (if configured) |
| `CODEX_CWD` | `process.cwd()` | working root for `codex exec` |
| `CODEX_MODEL` | — | optional `--model` override |

Runs `codex exec --sandbox read-only --cd <CODEX_CWD> --skip-git-repo-check --output-last-message <tmp> -`, feeding `systemPrompt + proposal` on stdin and returning the clean last message (falls back to stdout). Uses the CLI's own auth — no API key.

## antigravity-relay.ts

The **persistent gateway client** for Antigravity. Run it **outside** Antigravity (Antigravity cycles its own background processes, which would thrash a gateway connection). Registers as agent `antigravity`.

```bash
GATEWAY_URL=ws://localhost:3199 bun scripts/antigravity-relay.ts
```

- On assignment → writes `~/.floor-committee/pending/<id>.json`, holds the gateway promise open.
- Polls `~/.floor-committee/results/` every 400ms; when a vote file appears, forwards its content to the gateway and deletes the pending + result + `.announced` files.
- `committee-run.ts` and the pm2 `ecosystem.config.cjs` spawn this automatically; you rarely run it by hand.

## antigravity-notify.ts

The **stateless wake notifier**, run as a background task **inside** Antigravity. It is the event doorbell.

```bash
bun scripts/antigravity-notify.ts
```

- Scans `~/.floor-committee/pending/` (on start, on `fs.watch`, and every 1s); for each review without a `<id>.announced` marker, writes the marker, then prints `NEW_REVIEW <id>` to stdout — which wakes Antigravity.
- Writing the marker **before** printing makes it safe to be killed/restarted by Antigravity: each review wakes the agent exactly once, no death-loop, no duplicate reviews.
- Holds no gateway connection and no in-memory state.

## antigravity-mcp.ts

The **file-backed MCP server** Antigravity spawns (registered in `~/.gemini/config/mcp_config.json`). It holds no gateway connection — the relay owns that — so it is race-free and safe to lazy-spawn.

Tools:

| Tool | Behavior |
|------|----------|
| `get_pending_review()` | returns the oldest file in `pending/` (by mtime) as the RFC + reviewer instructions, or "No review pending." |
| `submit_vote(taskId, content)` | writes `results/<id>.json` atomically (tmp + rename) for the relay to forward |

All logging is routed to stderr so the JSON-RPC stdout channel stays clean.

## committee-smoke.ts

A minimal **2-way** (Claude + Codex) smoke test on a hardcoded RFC. Proves the gateway → Codex bridge → `codex exec` path and the internal Claude path without Things/GitHub. `bun scripts/committee-smoke.ts`.

## gateway-listen.ts

A diagnostic: starts a bare gateway and logs agent connect/disconnect — useful to confirm a bridge reaches the gateway before running a real round. `GATEWAY_PORT=3199 bun scripts/gateway-listen.ts`. No LLM spend.

---

## Shared file protocol

`antigravity-relay.ts` and `antigravity-mcp.ts` communicate through `~/.floor-committee/`:

```
pending/<id>.json        TaskAssignment   (relay writes, MCP reads)
pending/<id>.announced   dedup marker     (notify writes, relay deletes)
results/<id>.json        { taskId, content } (MCP writes, relay forwards + deletes)
```

`<id>` is the gateway task id with non-`[A-Za-z0-9._-]` characters replaced by `_`. Results are written atomically (tmp + rename) and consumed by **polling** (not `fs.watch`, which misses atomic renames on macOS).

## See also

- [Local Committee guide](./guides/local-committee.md) — setup and usage
- [Agent Gateway](./gateway.md) — WebSocket protocol and REST fallback
- [Orchestrator](./packages/orchestrator.md) — `executeCommitteeReview`, per-agent prompts
