# Committee Mode

Run a multi-agent technical committee that reviews proposals in parallel, votes, and syncs results to GitHub Discussions.

## How it works

1. A task tagged `committee` or `agents` triggers the pipeline (trigger tags are configurable via `COMMITTEE_LABELS`)
2. Internal agents are dispatched via their LLM adapters; external agents receive assignments via the [gateway](../gateway.md) WebSocket
3. All agents review in parallel — each returns `VOTE: APPROVE` or `VOTE: REJECT`
4. Votes are tallied (simple majority), results posted to Linear
5. If a GitHub Discussion is linked, the outcome is synced there

The same committee also reviews every PR an implementer opens, before a person sees it. Each member reads the diff inside its reviewer sandbox, the engine posts one signed PR comment per member plus a summary, and a majority approve with no blockers is the verdict. Timeouts abstain; fewer than two answers leaves the issue `in_review`. Merging stays with the coordinator.

In `floor-agents run --issue`, that PR review starts a gateway if none is running and spawns each external voter's CLI bridge for the duration of the vote (the same lifecycle `scripts/committee-run.ts` uses for RFC reviews). `watch` reuses its gateway and still starts the bridges per review. A bridge that cannot start abstains immediately with the reason on the PR; issue-comment polling is only for members with `voteByComment: true`. See [`review`](../configuration.md#review) in the configuration reference.

## Setup

### 1. Create a project config

The config lives in the target repository at `.agents/committee.yaml`. This keeps project-specific rules (domain knowledge, source references, constraints) with the code they describe.

```yaml
name: "My Project Technical Committee"

project:
  name: "my-project"
  repo: "my-project"
  language: "typescript"
  runtime: "bun"
  customInstructions: |
    Project-specific rules go here. This is injected into every
    agent's system prompt. Include architecture constraints,
    non-negotiable performance rules, key source file references,
    and any domain knowledge the committee needs.

agents:
  - id: claude
    name: "Claude"
    promptTemplate: "agents/committee.md"
    llm:
      provider: anthropic
      model: claude-opus-4-20250514
      temperature: 0.3
      maxTokens: 4096
    capabilities: [read_code, review_rfc, vote]
    autonomy: T1

  - id: gemini
    name: "Gemini"
    promptTemplate: "agents/committee.md"
    llm:
      provider: gemini
      model: gemini-2.5-pro
      temperature: 0.3
      maxTokens: 4096
    capabilities: [read_code, review_rfc, vote]
    autonomy: T1

  - id: gpt
    name: "GPT"
    promptTemplate: "agents/committee.md"
    llm:
      provider: openai
      model: gpt-4.1
      temperature: 0.3
      maxTokens: 4096
    capabilities: [read_code, review_rfc, vote]
    autonomy: T1
```

Agents can be internal (dispatched by the orchestrator) or external (connect via the gateway):

```yaml
agents:
  - id: codex
    name: "Codex (OpenAI)"
    llm:
      provider: openai
      model: codex-mini-latest
    capabilities: [vote]
    external: true          # connects via WebSocket gateway
```

See `config/templates/committee.yaml` for a complete example with workflow states, chain of command, guardrails, and cost limits.

### 2. Set environment variables

```bash
# Required
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=your-org
TASK_ADAPTER=linear
LINEAR_API_KEY=lin_api_...
LINEAR_TEAM_ID=...

# LLM providers (only what your agents use)
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
OPENAI_API_KEY=sk-...

# Point to the project config
CONFIG_PATH=/path/to/my-project/.agents/committee.yaml

# Gateway (only if using external agents)
GATEWAY_PORT=3100
GATEWAY_TOKEN=your-secret-token
```

### 3. Start the server

```bash
bun run src/main.ts
```

The entry point starts the committee pipeline when any agent has the `vote` capability, and the development pipeline as well if the manifest also holds implementers — the banner then reads `dev + committee mode`. For a committee-only manifest you'll see:

```
[floor-agents] starting (committee mode)
  company:   My Project Technical Committee
  project:   my-project (my-project)
  agents:    claude (anthropic), gemini (gemini), gpt (openai)
[committee] starting with 3 agents: claude, gemini, gpt
[committee] watching for labels: "committee", "agents"
[committee] GitHub Discussions sync: enabled
```

### 4. Create a proposal

In Linear, create an issue:

- **Label:** `committee`
- **Title:** RFC-003: New caching strategy
- **Body:** The full proposal text. To link a GitHub Discussion for sync, include `discussions/42` somewhere in the body.

The committee picks it up, all agents review in parallel, and results are posted back.

## One instance per project

Each project gets its own server instance pointed at its own config:

```bash
# vlist committee
CONFIG_PATH=/path/to/vlist/.agents/committee.yaml bun run src/main.ts

# another project
CONFIG_PATH=/path/to/other/.agents/committee.yaml bun run src/main.ts
```

Project-specific domain knowledge lives in `customInstructions` in the config — the agents framework stays generic.

## GitHub Discussions sync

When a vote completes, the result is automatically posted to the linked GitHub Discussion. The sync is triggered by the `sync.github` section in the config:

```yaml
sync:
  github:
    enabled: true
    owner: "your-org"
    repo: "your-repo"
    target: "discussions"
    syncOn: ["approved", "rejected"]
```

Link a discussion by including `discussions/<number>` or `Discussion #<number>` in the Linear issue body.

## Vote semantics

- **APPROVE:** Agent's response contains `VOTE: APPROVE` (case-insensitive)
- **REJECT:** Agent's response contains `VOTE: REJECT`
- **ABSTAIN:** Neither found (error, timeout, or ambiguous response)
- **Outcome:** Simple majority of non-abstaining votes. No quorum if all abstain.

## Customizing the committee prompt

The generic prompt lives at `agents/committee.md` in the agents repo. It handles voting mechanics and response format. Project-specific rules come from `customInstructions` in the config — not from the prompt file.

If you need a custom prompt, set `promptTemplate` to a different path in the agent definition.

## External agents

External agents (marked `external: true`) connect to the gateway WebSocket to receive assignments. The gateway starts automatically when external agents are present in `watch` mode. In `run --issue`, a gateway is started only for the committee PR review (if any external voter needs a bridge), on a free port handed to its bridges, and is torn down with them when the votes are in. Two runs reviewing at once therefore never collide on `GATEWAY_PORT`.

To run the included Codex agent yourself (for example alongside `watch`, if you are not using the engine-spawned bridges):

```bash
GATEWAY_URL=ws://localhost:3100 \
GATEWAY_TOKEN=your-secret-token \
OPENAI_API_KEY=sk-... \
bun scripts/codex-agent.ts
```

See the [Gateway documentation](../gateway.md) for the full protocol, REST fallback, and building custom agents.

If an external agent disconnects mid-review, the gateway re-queues its task and re-dispatches on reconnect. If it times out entirely, the agent's vote counts as ABSTAIN. When failed seats leave a review with no decision, fix the cause and run `floor-agents review --issue <id>`: the committee is seated again on the same pull request, without another implementer turn. If its bridge answers only to report that its CLI failed (quota, login, crash), the seat is recorded as a failed execution: its PR comment is headed "did not review", the summary quotes the last line of the error, and nothing in that error is read as a vote or a blocker. If its bridge never starts, the engine abstains immediately rather than waiting for a poll timeout.

An external member that should vote by posting on the issue instead of through a CLI bridge sets `voteByComment: true`. That is the only path that still polls issue comments.

## Cost controls

Committee reviews run multiple LLM calls in parallel. Set appropriate limits:

```yaml
costs:
  maxCostPerTask: 2.00   # per proposal
  maxCostPerDay: 20.00   # across all proposals
  warnCostThreshold: 1.00
```

The committee orchestrator checks daily limits before starting each review and skips proposals when the budget is exhausted.

## How a vote is read

A member's vote is its **last** `VOTE:` marker outside code — `APPROVE`, or any of `REJECT`,
`REQUEST_CHANGES`, `CHANGES REQUESTED`. A marker quoted in backticks or inside a fenced block is
an example, not a vote: a review that quoted "`VOTE: APPROVE`" and ended with **VOTE: REJECT**
was once recorded as an approval. No marker is an abstention.
