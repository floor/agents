# Floor Agents

**Your AI dev team. Plugs into your tools. Ships code while you sleep.**

Floor Agents gives any software team an autonomous AI engineering team. Connect your GitHub, your Linear, your preferred AI models — and get a team of specialized agents that write code, review PRs, and iterate on feedback.

```
Linear issue (labeled "agent")
  → Backend Dev (Gemma, local) writes code
  → CTO (Claude Code Opus) reviews the PR
  → If approved → done
  → If changes requested → dev revises, CTO reviews again
```

## How It Works

1. Create an issue in Linear with the `agent` label
2. The orchestrator picks it up and dispatches to the right agent
3. The dev agent reads the codebase, writes code, creates a PR
4. The CTO agent reviews the PR — approves or requests changes
5. The issue is updated with the PR link

No proprietary UI. All work happens in your Linear and GitHub.

## The Team

Each agent is a different AI model chosen for its strengths:

| Agent | Default Provider | Role |
|-------|-----------------|------|
| Backend Dev | LM Studio (Gemma) | Writes code, creates PRs |
| Frontend Dev | LM Studio (Gemma) | Writes code, creates PRs |
| CTO | Claude Code (Opus 4.6) | Reviews PRs, approves or rejects |
| PM | Anthropic API (Sonnet) | Decomposes tasks |
| QA | Anthropic API (Sonnet) | Writes tests |

Every agent is configurable — swap models, providers, or add custom agents. Use local models for free coding, cloud models for quality-critical reviews.

## Quick Start

```bash
# Install
bun install

# Configure
cp .env.example .env
# Edit .env with your GitHub token, Linear key, etc.

# Start LM Studio with Gemma loaded, then:
bun run src/main.ts
```

See [Getting Started](./docs/getting-started.md) for the full setup guide.

## Architecture

A monorepo with 9 packages, each with a single responsibility:

```
packages/
├── core/              Types, config loader, validation
├── anthropic/         Claude API adapter
├── claude-code/       Claude Code CLI adapter (spawns agent subprocess)
├── lmstudio/          LM Studio adapter (local models)
├── openai/            OpenAI-compatible adapter (OpenAI, Ollama, etc.)
├── github/            GitHub REST API (branches, commits, PRs)
├── task/              Task managers (Linear, Things 3)
├── context-builder/   File selection, prompt rendering, token budgets
└── orchestrator/      State machine, guardrails, cost tracking, team pipeline
```

### Key Design Decisions

- **Tool use over text parsing** — agents call `write_file` and `pr_description` as structured tool calls, not markdown or XML
- **Vendor-agnostic AI** — customers choose their LLM providers per agent. Mix local and cloud models in the same team
- **Config-driven** — a single YAML file defines the entire team: agents, models, guardrails, cost limits
- **Crash-recoverable** — 10-step execution state machine with file-based persistence. Restart safely at any point
- **Multi-agent review loop** — dev writes code, CTO reviews, dev revises (up to 3 cycles)

## Configuration

Everything is in `config/templates/default.yaml`:

```yaml
agents:
  - id: backend
    llm:
      provider: lmstudio           # or: anthropic, claude-code, openai, ollama
      model: google/gemma-4-e2b    # any model the provider supports
    capabilities: [read_code, write_code, create_pr, write_tests]

  - id: cto
    llm:
      provider: claude-code
      model: opus
    capabilities: [read_code, review_pr, approve, reject]

guardrails:
  maxFilesPerTask: 20
  blockedPaths: [".env*", "*.pem", ".github/workflows/*"]

costs:
  maxCostPerTask: 5.00
  maxCostPerDay: 50.00
```

See [Configuration Reference](./docs/configuration.md) for the full spec.

## Supported Providers

### LLM

| Provider | Package | Use Case |
|----------|---------|----------|
| Claude Code | `@floor-agents/claude-code` | Full codebase access. Best for dev + reviews. Max plan. |
| LM Studio | `@floor-agents/lmstudio` | Local models (Gemma, Llama, Qwen). Free. |
| Gemini | `@floor-agents/gemini` | Google Gemini 2.5 Pro/Flash. |
| Anthropic | `@floor-agents/anthropic` | Claude API (direct). Pay-per-token. |
| OpenAI | `@floor-agents/openai` | GPT-4o, o3. Also works with Ollama, Together, Groq. |

### Task Managers

| Provider | Status |
|----------|--------|
| Linear | Supported |
| Things 3 (macOS) | Supported |
| GitHub Issues | Supported |
| Jira | Planned |

### Git Platforms

| Provider | Status |
|----------|--------|
| GitHub | Supported |
| GitLab | Planned |
| Bitbucket | Planned |

## Safety

- **Guardrails** — file count/size limits, blocked paths (`.env`, `.pem`, CI configs), blocked extensions, path traversal detection
- **Cost controls** — per-task and per-day spending limits. Local models report $0
- **Review loop** — CTO agent reviews every PR before it's marked ready. Max 3 revision cycles, then `needs-human`
- **Crash recovery** — execution state persisted to disk between every step. Idempotent operations (branch creation, PR creation)

## Development

```bash
bun test              # 94 tests across 20 files
bun run typecheck     # type check all packages
bun run src/main.ts   # start the orchestrator
```

## Documentation

- [Getting Started](./docs/getting-started.md)
- [Configuration](./docs/configuration.md)
- [First Run Guide](./docs/guides/first-run.md)
- [Architecture](./docs/architecture.md)
- [Package Docs](./docs/README.md)
- [Adding an LLM Provider](./docs/guides/adding-llm-provider.md)
- [Adding a Task Manager](./docs/guides/adding-task-manager.md)
- [Testing](./docs/guides/testing.md)

## Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict)
- **Structure:** Monorepo with Bun workspaces
- **Config:** YAML
- **State:** File-based JSON (Phase 1), PostgreSQL (Phase 3)
- **Tests:** bun:test

## License

Proprietary. Floor IO SA.
