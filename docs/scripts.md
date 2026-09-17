# Scripts

Runnable helpers in `scripts/`. They are not part of any package — run them directly with `bun`. The committee scripts implement the all-local trio described in the [Local Committee guide](./guides/local-committee.md); this page is the code-level reference for each.

| Script | Role | Runs |
|--------|------|------|
| [`committee-run.ts`](#committee-runts) | Review an RFC file with the committee | by you (per round) |
| [`cursor-agent-bridge.ts`](#cursor-agent-bridgets) | Cursor gateway bridge → sandboxed `cursor-agent -p` (any Cursor model) | by the committee scripts |
| [`codex-agent.ts`](#codex-agentts) | Codex gateway bridge → `codex exec` | by `committee-run` / pm2 |
| [`grok-agent.ts`](#grok-agentts) | Grok gateway bridge → xAI's `grok --prompt-file` | by `committee-run` / pm2 |
| [`committee-smoke.ts`](#committee-smokets) | 2-way smoke test | by you (manual) |
| [`gateway-listen.ts`](#gateway-listents) | Bare gateway diagnostic | by you (manual) |
| `antigravity-relay.ts` / `antigravity-notify.ts` / `antigravity-mcp.ts` | **Parked** — Antigravity GUI bridge (no unattended wake) | — |

> The three `antigravity-*` scripts are retained for reference but are **not part of the default committee** — Antigravity cannot vote unattended. See [Appendix: why Antigravity is parked](./guides/local-committee.md#appendix-why-antigravity-is-parked).

**Which bridge runs** is decided by each external agent's `llm.provider` in the manifest (`scripts/lib/bridges.ts`), and every bridge registers under the manifest's agent id:

| `provider` | bridge | model from `llm.model` |
|---|---|---|
| `cursor` | `cursor-agent-bridge.ts` | required, e.g. `cursor-grok-4.6-high`, `gpt-5` |
| `codex-cli` | `codex-agent.ts` | optional, as `CODEX_MODEL` |
| `grok-cli` | `grok-agent.ts` (xAI's CLI) | optional, as `GROK_MODEL` |
| `antigravity` | `antigravity-relay.ts` | — |

Manifests that still name a vendor (`openai`, `gemini`) for `codex`, `grok` or `antigravity` resolve by agent id. Any other provider on an external agent stops the run before a process starts.

---

## committee-run.ts

Runs one committee review on an RFC **markdown file**, without `main.ts`, Linear, or GitHub. It stands up a real [gateway](./gateway.md), spawns the external-agent bridges it needs (one per external member — Codex and Grok), reads the RFC, runs `executeCommitteeReview`, prints the votes, and tears everything down.

```bash
RFC_FILE=~/Code/floor/vlist.io/docs/rfcs/RFC-013.md \
CODEX_CWD=~/Code/floor/vlist \
AGENTS=claude,codex,grok \
bun scripts/committee-run.ts
```

| Env | Default | Meaning |
|-----|---------|---------|
| `RFC_FILE` | — (required) | RFC markdown; YAML frontmatter stripped, first `# heading` → title |
| `CODEX_CWD` | `~/Code/floor/vlist` | repo the reviewers read for grounding |
| `AGENTS` | `claude,codex,grok` | comma-separated committee agent ids to include |
| `GATEWAY_PORT` | `3199` | gateway port |
| `EXTERNAL_TIMEOUT_MS` | `600000` | per-external-agent vote timeout |

- Loads the reviewed repository's manifest, `<CODEX_CWD>/.agents/agents.yaml` (override with `COMMITTEE_CONFIG`); the committee is the agents with the `vote` capability that are listed in `AGENTS`, and an empty committee stops the run.
- Claude (`claude-code`) is wired via `createClaudeCodeAdapter` with read-only tools (`Read/Glob/Grep/Bash`), `cwd = CODEX_CWD`.
- Spawns `codex-agent.ts` if `codex` is included and `grok-agent.ts` if `grok` is included; waits for each external bridge to connect before dispatching.
- `contextBuilder`/`stateStore` are unused by `executeCommitteeReview` and passed as stubs; `taskAdapter` is an in-memory stub that just logs the committee's posts.
- Exits 0 after printing the tally; kills the bridges and stops the gateway.

## codex-agent.ts

Gateway client for **Codex**. Registers as agent `codex`, and on each assignment runs the local Codex CLI in a [reviewer sandbox](./guides/sandbox.md), returning the final message as the review.

```bash
GATEWAY_URL=ws://localhost:3199 CODEX_CWD=~/Code/floor/vlist bun scripts/codex-agent.ts
```

| Env | Default | Meaning |
|-----|---------|---------|
| `GATEWAY_URL` | `ws://localhost:3199` | gateway to connect to |
| `GATEWAY_TOKEN` | — | gateway auth token (if configured) |
| `CODEX_CWD` | `process.cwd()` | working root for `codex exec` |
| `CODEX_MODEL` | — | optional `--model` override |

Runs `sandbox-exec -p <reviewer profile> codex exec --sandbox danger-full-access --cd <CODEX_CWD> --skip-git-repo-check --output-last-message <tmp> -` — Codex's own sandbox cannot nest inside ours, so ours contains it, denying the paths in `FLOOR_AGENTS_DENY_READ` (the manifest's private sources, when `codex-cli` is not trusted with them). With `FLOOR_AGENTS_SANDBOX=off` it runs `codex exec --sandbox read-only` instead. It feeds `systemPrompt + proposal` on stdin and returning the clean last message (falls back to stdout). Uses the CLI's own auth — no API key.

## grok-agent.ts

Gateway client for **Grok** — the third committee member, replacing the parked Antigravity seat. Registers as agent `grok`, and on each assignment runs the local Grok CLI headless in a read-only sandbox, returning stdout as the review.

```bash
GATEWAY_URL=ws://localhost:3199 GROK_CWD=~/Code/floor/vlist bun scripts/grok-agent.ts
```

| Env | Default | Meaning |
|-----|---------|---------|
| `GATEWAY_URL` | `ws://localhost:3199` | gateway to connect to |
| `GATEWAY_TOKEN` | — | gateway auth token (if configured) |
| `GROK_CWD` | `process.cwd()` | working root for the review |
| `GROK_MODEL` | — | optional `--model` override |
| `GROK_EFFORT` | — (unset) | optional `--effort`; **leave unset for `grok-build`**, which rejects `reasoningEffort` (HTTP 400) |
| `GROK_SANDBOX` | `read-only` | sandbox profile |
| `GROK_BIN` | `grok` | path to the Grok binary |

Writes `systemPrompt + proposal` to a temp file and runs `grok --prompt-file <tmp> --cwd <GROK_CWD> --output-format plain --permission-mode dontAsk --sandbox read-only`, returning trimmed stdout (clean final message, no tool noise). Prereq: `grok login`. Uses the CLI's own auth — no API key.

## cursor-agent-bridge.ts

Gateway client for **any Cursor-hosted model**. Registers under the manifest's agent id and, on each assignment, runs one headless `cursor-agent -p` turn with the manifest's model against the repository, on the Cursor subscription.

```bash
GATEWAY_URL=ws://localhost:3199 AGENT_ID=grok CURSOR_MODEL=cursor-grok-4.6-high \
REVIEW_CWD=~/Code/floor/vlist bun scripts/cursor-agent-bridge.ts
```

| Env | Default | Meaning |
|-----|---------|---------|
| `AGENT_ID` | — (required) | gateway agent id, from the manifest |
| `CURSOR_MODEL` | — (required) | model identifier, from the manifest |
| `REVIEW_CWD` | `process.cwd()` | repository the review reads |
| `AGENT_NAME` | `<id> (Cursor)` | display name |
| `GATEWAY_URL` / `GATEWAY_TOKEN` | `ws://localhost:3100` / — | gateway |
| `EXTERNAL_TIMEOUT_MS` | 600000 | per-turn timeout |

- **Sandboxed.** Every turn runs in a [reviewer sandbox](./guides/sandbox.md): it reads the repository directly and cannot write anything outside Cursor's own state, nor read credential stores or `.env` files. Without it, `cursor-agent`'s edit tool writes outside its working directory even under `--trust`.
- **No verdict, one retry.** A reply without `VOTE:` or `RECOMMEND:` is retried once; a second empty reply is returned as-is, so the committee records an abstention rather than a vote nobody cast.
- Prereq: `cursor-agent login`.

## Parked: antigravity-relay.ts / antigravity-notify.ts / antigravity-mcp.ts

The three-part file-backed bridge that let the **Antigravity GUI IDE** participate. Retained for reference but **not in the default committee**: Antigravity's agent (Cascade) has no external push and does not wake on background-task stdout, so it cannot vote unattended. The full mechanism and the supporting evidence are in [Appendix: why Antigravity is parked](./guides/local-committee.md#appendix-why-antigravity-is-parked). Grok (a headless CLI) took the seat.

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
