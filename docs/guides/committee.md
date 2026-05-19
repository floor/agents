# Committee Mode

Run a multi-agent technical committee that reviews proposals in parallel, votes, and syncs results to GitHub Discussions.

## How it works

1. A Linear issue with the `committee` label triggers the pipeline
2. Internal agents are dispatched via their LLM adapters; external agents receive assignments via the [gateway](../gateway.md) WebSocket
3. All agents review in parallel — each returns `VOTE: APPROVE` or `VOTE: REJECT`
4. Votes are tallied (simple majority), results posted to Linear
5. If a GitHub Discussion is linked, the outcome is synced there

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

The entry point auto-detects committee mode when any agent has the `vote` capability. You'll see:

```
[floor-agents] starting (committee mode)
  company:   My Project Technical Committee
  project:   my-project (my-project)
  agents:    claude (anthropic), gemini (gemini), gpt (openai)
[committee] starting with 3 agents: claude, gemini, gpt
[committee] watching for label: "committee"
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

External agents (marked `external: true`) connect to the gateway WebSocket to receive assignments. The gateway starts automatically when external agents are present.

To run the included Codex agent:

```bash
GATEWAY_URL=ws://localhost:3100 \
GATEWAY_TOKEN=your-secret-token \
OPENAI_API_KEY=sk-... \
bun scripts/codex-agent.ts
```

See the [Gateway documentation](../gateway.md) for the full protocol, REST fallback, and building custom agents.

If an external agent disconnects mid-review, the gateway re-queues its task and re-dispatches on reconnect. If it times out entirely, the agent's vote counts as ABSTAIN.

## Cost controls

Committee reviews run multiple LLM calls in parallel. Set appropriate limits:

```yaml
costs:
  maxCostPerTask: 2.00   # per proposal
  maxCostPerDay: 20.00   # across all proposals
  warnCostThreshold: 1.00
```

The committee orchestrator checks daily limits before starting each review and skips proposals when the budget is exhausted.
