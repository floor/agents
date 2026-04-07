# Configuration

Floor Agents is configured through two layers: a YAML config file and environment variables.

## Environment Variables

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `GITHUB_TOKEN` | Yes | — | GitHub personal access token |
| `GITHUB_OWNER` | Yes | — | GitHub org or user that owns the repos |
| `TASK_ADAPTER` | No | `linear` | Task adapter type: `linear`, `things`, or `github-issues` |
| `LINEAR_API_KEY` | If linear | — | Linear API key |
| `LINEAR_TEAM_ID` | If linear | — | Linear team ID or key (e.g. `FLO`) |
| `LINEAR_PROJECT_ID` | No | — | Filter issues to a specific Linear project |
| `ANTHROPIC_API_KEY` | If used | — | Anthropic API key (only if agents use `provider: anthropic`) |
| `GEMINI_API_KEY` | If used | — | Google Gemini API key (only if agents use `provider: gemini`) |
| `LMSTUDIO_BASE_URL` | No | `http://localhost:1234/v1` | LM Studio server URL |
| `LMSTUDIO_API_KEY` | No | — | LM Studio API key (usually not needed) |
| `OPENAI_API_KEY` | If used | — | OpenAI API key |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `CLAUDE_CODE_MODEL` | No | — | Model override for Claude Code adapter (`opus`, `sonnet`) |
| `CONFIG_PATH` | No | `config/templates/default.yaml` | Path to company config |
| `STATE_DIR` | No | `./data/executions` | Directory for execution state files |

**Key principle:** only providers referenced by your agent definitions require their env vars. If all agents use `provider: lmstudio`, you don't need `ANTHROPIC_API_KEY`.

## YAML Config Reference

The company config is a single YAML file that defines your entire agent team.

### Top-level structure

```yaml
name: "My Team"          # Team name

project: { ... }         # Repository and conventions
agents: [ ... ]          # Agent definitions
workflow: { ... }        # State machine (Phase 1: defined only)
chain: { ... }           # Chain of command (Phase 1: defined only)
autonomy: { ... }        # Autonomy rules (Phase 1: defined only)
guardrails: { ... }      # Safety boundaries
costs: { ... }           # Spending limits
statusMapping: { ... }   # Internal → task manager status mapping
```

### `project`

```yaml
project:
  name: "floor-agents"              # Project name (required)
  repo: "floor/agents"              # GitHub owner/repo (required)
  language: "typescript"             # Primary language
  runtime: "bun"                     # Runtime environment
  conventions:
    semicolons: false
    quotes: "single"
    indent: 2
    modules: "esm"
    testRunner: "bun:test"
  structure:
    backend: "packages/"
    tests: "test/"
  packages: []                       # Monorepo workspace paths
  customInstructions: |              # Free-form instructions for all agents
    Use Bun.file over node:fs.
    No external dependencies for API calls.
```

### `agents`

Each agent has an ID, a role, an LLM configuration, and capabilities.

```yaml
agents:
  - id: backend                      # Unique ID (matches issue labels for dispatch)
    name: "Backend Developer"        # Human-readable name
    promptTemplate: "agents/backend-dev.md"  # Path to role prompt
    llm:
      provider: lmstudio             # anthropic | lmstudio | openai | ollama | local
      model: google/gemma-4-e2b      # Model ID (as the provider knows it)
      temperature: 0.2               # 0.0 – 1.0
      maxTokens: 8000                # Max output tokens
    capabilities:                    # What this agent can do
      - read_code
      - write_code
      - create_pr
      - write_tests
    autonomy: T1                     # T1: fully autonomous, T2: recommends, T3: presents options
    customInstructions: ""           # Per-agent instructions appended to prompt
```

**Available capabilities:** `read_code`, `write_code`, `create_pr`, `review_pr`, `write_tests`, `decompose_task`, `manage_issues`, `approve`, `reject`

**Available providers:** `anthropic`, `claude-code`, `gemini`, `lmstudio`, `openai`, `ollama`, `local`

### `guardrails`

Safety boundaries enforced before any code is committed.

```yaml
guardrails:
  maxFilesPerTask: 20                # Max files per agent output
  maxFileSizeBytes: 102400           # 100 KB per file
  maxTotalOutputBytes: 512000        # 500 KB total
  blockedPaths:                      # Glob patterns — never write to these
    - ".env*"
    - "*.pem"
    - "*.key"
    - ".github/workflows/*"
  allowedPaths: []                   # If set, output restricted to these paths only
  blockedExtensions:                 # Never create files with these extensions
    - ".env"
    - ".pem"
    - ".key"
    - ".exe"
```

### `costs`

Spending limits to prevent runaway LLM costs.

```yaml
costs:
  maxCostPerTask: 5.00               # Abort task if cost exceeds this (USD)
  maxCostPerDay: 50.00               # Stop picking up new tasks after this daily total
  warnCostThreshold: 2.00            # Comment a warning on the issue above this
```

Note: local models (LM Studio, Ollama) always report $0 cost.

### `statusMapping`

Maps internal states to your task manager's status names.

```yaml
statusMapping:
  backlog: "Backlog"
  triage: "Triage"
  in_progress: "In Progress"
  in_review: "In Review"
  changes_requested: "In Progress"
  qa: "In Review"
  done: "Done"
  needs_human: "Blocked"
```

## Example: Local-only config (LM Studio + Things)

Minimal config for local development — no API keys, no cloud services:

```yaml
name: "Local Dev"

project:
  name: "my-app"
  repo: "myuser/my-app"
  language: "typescript"
  runtime: "bun"
  conventions: {}
  structure:
    backend: "src/"
  packages: []
  customInstructions: ""

agents:
  - id: backend
    name: "Backend Developer"
    promptTemplate: "agents/backend-dev.md"
    llm:
      provider: lmstudio
      model: google/gemma-4-e2b
      temperature: 0.2
      maxTokens: 8000
    capabilities: [read_code, write_code, create_pr, write_tests]
    autonomy: T1
    customInstructions: ""

guardrails:
  maxFilesPerTask: 20
  maxFileSizeBytes: 102400
  maxTotalOutputBytes: 512000
  blockedPaths: [".env*", "*.pem", "*.key"]
  allowedPaths: []
  blockedExtensions: [".env", ".pem", ".key"]

costs:
  maxCostPerTask: 5.00
  maxCostPerDay: 50.00
  warnCostThreshold: 2.00

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

With env:
```bash
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=myuser
TASK_ADAPTER=things
CONFIG_PATH=config/local.yaml
```
