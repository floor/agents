# Floor Agents — Documentation

A **Bun-native** AI agent orchestration **service** (and **library**) with **zero
dependencies**. Run it as a long-running process that watches your task source and
orchestrates agents, or embed the engine in your own Bun app.

## Overview

- [Architecture](./architecture.md) — system design, principles, competitive landscape, rollout plan
- [Phase 1 Spec](./Phase1-Specs_1.md) — detailed specification for the MVP implementation
- [Getting Started](./getting-started.md) — setup, configuration, first run
- [Configuration](./configuration.md) — YAML config reference, environment variables
- [Agents & the Team](./agents.md) — agents are fully configurable; capabilities, modes, personas
- [CLI](./cli.md) — the `floor-agents` binary: flags, env vars, modes, trigger tags
- [Scripts](./scripts.md) — committee runner + gateway bridges (`scripts/`) reference
- [Known Issues](./known-issues.md) — tracked issues and their resolution status
- [Next Steps](./next-steps.md) — prioritized roadmap after three sprints of dogfooding

## Packages

Each package has its own documentation:

| Package | Description | Doc |
|---------|-------------|-----|
| `@floor-agents/core` | Types, config loader, utilities | [core](./packages/core.md) |
| `@floor-agents/anthropic` | Anthropic LLM adapter | [anthropic](./packages/anthropic.md) |
| `@floor-agents/lmstudio` | LM Studio adapter for local models | [lmstudio](./packages/lmstudio.md) |
| `@floor-agents/claude-code` | Claude Code adapter (CTO agent) | [claude-code](./packages/claude-code.md) |
| `@floor-agents/gemini` | Google Gemini adapter | [gemini](./packages/gemini.md) |
| `@floor-agents/openai` | OpenAI-compatible adapter | [openai](./packages/openai.md) |
| `@floor-agents/github` | GitHub git adapter | [github](./packages/github.md) |
| `@floor-agents/task` | Task manager adapters | [task](./packages/task.md) |
| `@floor-agents/context-builder` | Context assembly + prompts | [context-builder](./packages/context-builder.md) |
| `@floor-agents/orchestrator` | Main loop + state machine | [orchestrator](./packages/orchestrator.md) |
| `@floor-agents/gateway` | WebSocket server for external agents | [gateway](./gateway.md) |

## Guides

- [First Run](./guides/first-run.md) — end-to-end setup with Gemma + Claude Code Opus
- [Zero-Cost Committee](./guides/zero-cost-committee.md) — Claude Code + Gemma + Codex for $0/review
- [Committee Mode](./guides/committee.md) — multi-agent proposal review with parallel voting
- [Local Committee](./guides/local-committee.md) — Claude Code + Codex + Antigravity, event-driven, no cloud keys
- [Agent Gateway](./gateway.md) — WebSocket protocol, REST fallback, building custom agents
- [Adding an LLM Provider](./guides/adding-llm-provider.md)
- [Adding a Task Manager](./guides/adding-task-manager.md)
- [Testing](./guides/testing.md)

## Experiments

- [2026-04-07: First Sprint](./experiments/2026-04-07-first-sprint.md) — 5 issues, 5 PRs, Gemma + Opus, $0.32 total
- [2026-04-07: Second Sprint](./experiments/2026-04-07-second-sprint.md) — 5 issues, 5 PRs, Claude Code Sonnet + Opus, $1.23 total
- [2026-04-08: Third Sprint](./experiments/2026-04-08-third-sprint.md) — 5 complex issues, 2 timeouts, architectural lessons learned
- [2026-04-08: Fourth Sprint](./experiments/2026-04-08-fourth-sprint.md) — native worktree execution, editing works, push pending
