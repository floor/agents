# Agents & the Team

**The team is 100% configurable.** There are no hardcoded agents in the engine — every
agent is a config entry. The "team" you see in the README is just the default config
(`config/templates/default.yaml`); swap models, rename roles, add or remove agents freely.

## What an agent is

An agent is one entry in the `agents:` array of your [config](./configuration.md):

```yaml
agents:
  - id: cto                              # unique id
    name: "CTO"                          # display name
    promptTemplate: "agents/cto.md"      # path to its prompt (persona)
    llm:
      provider: claude-code              # any provider you've configured
      model: opus
      temperature: 0.3
      maxTokens: 32000
    capabilities: [read_code, review_pr, approve, reject]
    external: false                      # internal (LLM adapter) vs external (gateway)
    autonomy: T1
    customInstructions: ""               # appended to the persona
```

| Field | Meaning |
|-------|---------|
| `id` / `name` | identity |
| `llm` | provider + model + sampling — see [Adding an LLM Provider](./guides/adding-llm-provider.md) |
| `capabilities` | what the agent does (below) |
| `promptTemplate` | path to its prompt file (its persona) |
| `external` | `true` = runs via the [gateway](./gateway.md); `false`/omitted = in-process LLM adapter |
| `customInstructions` | extra instructions appended to the persona |

## Capabilities

`read_code`, `write_code`, `create_pr`, `review_pr`, `write_tests`, `decompose_task`,
`manage_issues`, `approve`, `reject`, `review_rfc`, `vote`.

Capabilities declare an agent's role. Two of them **drive behavior** today:

- **`vote`** — putting any agent in `vote` switches the orchestrator into **committee mode**
  (parallel review + majority vote). That agent participates in reviews. Also use
  `review_rfc`.
- **`review_pr`** — in **dev mode**, the agent with `review_pr` is the PR reviewer (the CTO).

The rest (`write_code`, `create_pr`, `write_tests`, …) describe what dev agents do.
`decompose_task` is the PM's capability — its implementation exists but isn't wired in yet
(see [Next Steps §2](./next-steps.md)).

## Internal vs external agents

- **Internal** (`external: false`): dispatched in-process via the agent's LLM adapter
  (Anthropic, Gemini, LM Studio, OpenAI-compatible, Claude Code).
- **External** (`external: true`): connect over the [gateway](./gateway.md) WebSocket. This
  is how local tools join — e.g. the Codex CLI and the Antigravity IDE in the
  [Local Committee](./guides/local-committee.md). External agents need no provider API key.

## Personas (`promptTemplate`)

Each agent reviews/works through its own prompt — its **persona**. `promptTemplate` points
to a markdown file (e.g. `agents/codex-reviewer.md` — pragmatic, migration-risk lens;
`agents/antigravity-reviewer.md` — browser internals). The engine loads it as the agent's
system prompt; if the file is missing it falls back to a generic prompt, so a `promptTemplate`
path is never load-bearing.

## Modes (auto-detected)

- **Committee** — any agent has `vote`. Review-only: agents review a proposal in parallel and
  vote. Triggered by the `committee`/`agents` tags (see [CLI](./cli.md)).
- **Dev** — otherwise. PM → dev → CTO review → QA pipeline that writes code and opens PRs.

## The predefined teams are examples

`agents/` (prompt files) and `config/templates/` (`default.yaml`, `committee.yaml`) are
**examples**, not part of the published package — bring your own. Two starting points:

- **`committee.yaml`** — the parallel-review committee. Fully wired; this is the solid path
  (and what [Local Committee](./guides/local-committee.md) builds on).
- **`default.yaml`** — the dev team (Backend / Frontend / CTO / PM / QA). The dev pipeline
  works, but PM decomposition and the configurable workflow engine are
  [not yet wired](./next-steps.md) — treat it as the aspirational roster.

## Add a custom agent

Just add an entry — no code:

```yaml
agents:
  - id: security
    name: "Security Reviewer"
    promptTemplate: "agents/security.md"
    llm: { provider: anthropic, model: claude-opus-4-20250514, temperature: 0.2, maxTokens: 8000 }
    capabilities: [read_code, review_rfc, vote]
    autonomy: T1
    customInstructions: "Focus on authz, input validation, and secret handling."
```

## See also

- [Configuration](./configuration.md) — full YAML reference
- [CLI](./cli.md) — running the team, modes, trigger tags
- [Local Committee](./guides/local-committee.md) — a local CLI/IDE trio via the gateway
