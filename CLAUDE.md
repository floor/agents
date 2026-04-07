# Floor Agents

AI engineering team as a service. See `docs/architecture.md` for full context.

## Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict)
- **Module system:** ESM
- **Structure:** Monorepo with Bun workspaces (`packages/*`)

## Packages

- `@floor-agents/core` — types, config loader, utilities
- `@floor-agents/anthropic` — Anthropic LLM adapter (tool use)
- `@floor-agents/lmstudio` — LM Studio adapter for local models (Gemma, Llama, Qwen, etc.)
- `@floor-agents/openai` — OpenAI-compatible adapter (OpenAI, Ollama, Together, Groq, etc.)
- `@floor-agents/github` — GitHub git adapter
- `@floor-agents/task` — task manager adapters (Linear, Things 3, future: GitHub Issues, Jira)
- `@floor-agents/context-builder` — context assembly + prompt rendering
- `@floor-agents/orchestrator` — main loop, state machine, guardrails, cost tracking

## Commands

- `bun run src/main.ts` — start the orchestrator
- `bun test` — run tests
- `bun run typecheck` — type check without emitting

## Conventions

- Use `Bun.$` for shell commands, not `execa` or `child_process`
- Use `Bun.file` over `node:fs` for file reads/writes
- Use `bun:test` for tests
- No semicolons, single quotes, 2-space indent
- Prefer `type` over `interface` for object shapes
- All adapter implementations must satisfy their interface in `@floor-agents/core`
- Config is YAML (`config/templates/default.yaml`)
- LLM output via tool use (`write_file`, `pr_description`), not text parsing
