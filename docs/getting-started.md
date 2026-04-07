# Getting Started

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- A GitHub account with a personal access token
- A task manager: [Linear](https://linear.app) account or [Things 3](https://culturedcode.com/things/) (macOS)
- At least one LLM provider:
  - [LM Studio](https://lmstudio.ai) for local models (free)
  - [Anthropic API key](https://console.anthropic.com) for Claude
  - Any OpenAI-compatible endpoint

## Install

```bash
git clone <repo-url> floor-agents
cd floor-agents
bun install
```

## Configure

### 1. Environment variables

```bash
cp .env.example .env
```

Edit `.env` with your credentials. Only fill in what you need:

```bash
# Always required
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=your-org

# Task adapter (pick one)
TASK_ADAPTER=linear          # or: things
LINEAR_API_KEY=lin_api_...   # only if TASK_ADAPTER=linear
LINEAR_TEAM_ID=...           # only if TASK_ADAPTER=linear

# LLM providers (only what your agents use)
ANTHROPIC_API_KEY=sk-ant-... # only if agents use provider: anthropic
LMSTUDIO_BASE_URL=http://localhost:1234/v1  # only if agents use provider: lmstudio
```

### 2. Company config (YAML)

Edit `config/templates/default.yaml` or create your own:

```bash
cp config/templates/default.yaml config/my-team.yaml
# Edit config/my-team.yaml
CONFIG_PATH=config/my-team.yaml  # add to .env
```

See [Configuration](./configuration.md) for the full YAML reference.

### 3. Start LM Studio (if using local models)

1. Open LM Studio
2. Load a model (e.g. Gemma 4 E2B, Qwen3 Coder)
3. Start the server (default: `http://localhost:1234`)

## Run

```bash
bun run src/main.ts
```

The orchestrator will:
1. Load and validate your config
2. Create adapters for the providers your agents use
3. Resume any incomplete tasks from previous runs
4. Start watching for new issues

## Create your first task

1. In Linear, create an issue with the `agent` label
2. The orchestrator picks it up within seconds
3. An agent builds context, calls the LLM, creates a PR
4. The issue is updated with the PR link

## Verify

```bash
bun test         # run all tests (57 tests)
bun run typecheck  # type check all packages
```
