# Floor Agents — Documentation

## Overview

- [Architecture](./architecture.md) — system design, principles, competitive landscape, rollout plan
- [Phase 1 Spec](./Phase1-Specs_1.md) — detailed specification for the MVP implementation
- [Getting Started](./getting-started.md) — setup, configuration, first run
- [Configuration](./configuration.md) — YAML config reference, environment variables
- [Known Issues](./known-issues.md) — tracked issues and their resolution status

## Packages

Each package has its own documentation:

| Package | Description | Doc |
|---------|-------------|-----|
| `@floor-agents/core` | Types, config loader, utilities | [core](./packages/core.md) |
| `@floor-agents/anthropic` | Anthropic LLM adapter | [anthropic](./packages/anthropic.md) |
| `@floor-agents/lmstudio` | LM Studio adapter for local models | [lmstudio](./packages/lmstudio.md) |
| `@floor-agents/claude-code` | Claude Code adapter (CTO agent) | [claude-code](./packages/claude-code.md) |
| `@floor-agents/openai` | OpenAI-compatible adapter | [openai](./packages/openai.md) |
| `@floor-agents/github` | GitHub git adapter | [github](./packages/github.md) |
| `@floor-agents/task` | Task manager adapters | [task](./packages/task.md) |
| `@floor-agents/context-builder` | Context assembly + prompts | [context-builder](./packages/context-builder.md) |
| `@floor-agents/orchestrator` | Main loop + state machine | [orchestrator](./packages/orchestrator.md) |

## Guides

- [First Run](./guides/first-run.md) — end-to-end setup with Gemma + Claude Code Opus
- [Adding an LLM Provider](./guides/adding-llm-provider.md)
- [Adding a Task Manager](./guides/adding-task-manager.md)
- [Testing](./guides/testing.md)
