# Zero-Cost Committee Setup

Run a full technical committee with three AI agents for $0 per review. This guide sets up Claude Code (Max plan), Gemma 4 (local via LM Studio), and Codex (existing OpenAI plan) as a voting committee.

## Why zero cost

| Agent | Provider | Billing |
|-------|----------|---------|
| Claude | Claude Code (Max plan) | Included in subscription |
| Gemma | LM Studio (local) | Free — runs on your GPU |
| Codex | OpenAI Codex (existing plan) | Included in subscription |

No per-token API charges. The orchestrator reports $0 for every review.

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with a Max plan subscription
- [LM Studio](https://lmstudio.ai) with a GPU that can run Gemma 4 26B (16GB+ VRAM)
- An [OpenAI platform account](https://platform.openai.com) with Codex access
- GitHub token and Linear workspace

## 1. Load Gemma in LM Studio

1. Open LM Studio
2. Download **Gemma 4 26B** (or the variant that fits your GPU)
3. Load the model and start the local server
4. Verify: `curl http://localhost:1234/v1/models` should list the model

## 2. Create the project config

In your target project's repo, create `.agents/committee.yaml`:

```yaml
name: "My Project Technical Committee"

project:
  name: "my-project"
  repo: "my-org/my-project"
  language: "typescript"
  runtime: "bun"
  customInstructions: |
    Your project-specific rules, architecture constraints,
    and domain knowledge go here. This is injected into
    every agent's system prompt.

agents:
  - id: claude
    name: "Claude (Claude Code)"
    promptTemplate: "agents/committee.md"
    llm:
      provider: claude-code
      model: claude-opus-4-20250514
    capabilities: [read_code, review_rfc, vote]
    autonomy: T1
    customInstructions: ""

  - id: gemma
    name: "Gemma 4 26B (LM Studio)"
    promptTemplate: "agents/committee.md"
    llm:
      provider: lmstudio
      model: gemma4-26b-a4b
      temperature: 0.3
      maxTokens: 4096
    capabilities: [read_code, review_rfc, vote]
    autonomy: T1
    customInstructions: ""

  - id: codex
    name: "Codex (OpenAI)"
    promptTemplate: "agents/committee.md"
    llm:
      provider: openai
      model: codex-mini-latest
    capabilities: [vote]
    autonomy: T1
    customInstructions: ""
    external: true

guardrails:
  maxFilesPerTask: 20
  maxFileSizeBytes: 102400
  maxTotalOutputBytes: 512000
  blockedPaths: [".env*", "*.pem", "*.key"]
  allowedPaths: []
  blockedExtensions: [".env", ".pem", ".key"]

costs:
  maxCostPerTask: 0.00
  maxCostPerDay: 0.00
  warnCostThreshold: 0.00

workflow:
  states: []
  transitions: []
chain:
  nodes: []
autonomy:
  default: T1
  overrides: []
statusMapping: {}
```

Key points:
- Claude and Gemma are **internal** — the orchestrator dispatches to them directly
- Codex is **external** (`external: true`) — it connects via the WebSocket gateway
- Cost limits are $0 — all providers are subscription/local

## 3. Set environment variables

```bash
# Core
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=my-org
TASK_ADAPTER=linear
LINEAR_API_KEY=lin_api_...
LINEAR_TEAM_ID=...

# Config
CONFIG_PATH=/path/to/my-project/.agents/committee.yaml

# Gateway (for Codex external agent)
GATEWAY_PORT=3100
GATEWAY_TOKEN=pick-a-strong-secret

# OpenAI (for Codex agent script)
OPENAI_API_KEY=sk-...
```

No `ANTHROPIC_API_KEY` needed — Claude Code uses the Max plan auth.

## 4. Start the orchestrator

```bash
bun run src/main.ts
```

You should see:

```
[floor-agents] starting (committee mode)
  agents:    claude (claude-code), gemma (lmstudio), codex (openai)
[committee] starting with 2 internal + 1 external agents
[gateway] listening on ws://localhost:3100/ws
```

## 5. Start the Codex agent

In a separate terminal:

```bash
GATEWAY_URL=ws://localhost:3100 \
GATEWAY_TOKEN=pick-a-strong-secret \
OPENAI_API_KEY=sk-... \
bun scripts/codex-agent.ts
```

You should see:

```
[codex] starting — gateway=ws://localhost:3100
[client:codex] connecting to ws://localhost:3100
[client:codex] registered
```

## 6. Submit a proposal

In Linear, create an issue:

- **Label:** `committee`
- **Title:** RFC-001: Your proposal title
- **Body:** The full proposal text

Within seconds:
1. Claude and Gemma start reviewing (internal, parallel)
2. The gateway dispatches the assignment to Codex (external, WebSocket)
3. All three votes come back
4. The tally is posted to Linear

## What happens on failure

| Scenario | Behavior |
|----------|----------|
| Codex disconnects mid-review | Gateway re-queues the task, re-dispatches on reconnect |
| Codex times out (5 min default) | Vote counts as ABSTAIN, committee continues with 2 votes |
| LM Studio is down | Gemma's vote counts as ABSTAIN (error caught) |
| All agents abstain | Outcome: `no_quorum` — posted to Linear, no status change |

## GitHub Discussions sync

To sync results to a public GitHub Discussion, add the repo to your config:

```yaml
project:
  repo: "my-org/my-project"  # enables Discussions sync
```

And include a reference in the Linear issue body: `discussions/42` or `Discussion #42`.

The vote outcome is posted as a comment on the linked discussion.

## Running with PM2

For long-running operation:

```bash
pm2 start ecosystem.config.cjs
pm2 start scripts/codex-agent.ts --interpreter bun --name codex-agent
```
