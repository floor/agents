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
| `GATEWAY_PORT` | No | `3100` | WebSocket gateway port (external agents) |
| `GATEWAY_TOKEN` | No | — | Shared secret for gateway auth (WS + REST) |
| `TELEGRAM_BOT_TOKEN` | No | — | Bot token; with `TELEGRAM_CHAT_ID`, every comment a run posts on its issue is repeated in that chat |
| `TELEGRAM_CHAT_ID` | No | — | Chat or channel the run posts to |
| `TELEGRAM_ALLOW_FROM` | No | — | Comma-separated user ids allowed to interject; in a group, required before anyone is trusted |

**Per project:** the manifest's directory may carry a `.env` (`.agents/.env`), loaded before
anything reads the environment. A Telegram chat per project lives there, or a token scoped to
one repository. A variable already set in the shell wins over the file. Bun loads the engine's
own `.env` only when a process starts in the engine's directory; a run starts in the project's.

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
sources: { ... }         # Material beside the repository, public or private
review: { ... }          # How implementer PRs are reviewed
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
    timeoutMs: 1800000               # How long one turn may run (default 600000, ten minutes)
    maxTurns: 500                    # Tool calls one turn may make (claude-code; default 300 implementing, 60 reviewing)
    customInstructions: ""           # Per-agent instructions appended to prompt
    external: false                  # If true, agent connects via gateway WebSocket
```

**Available capabilities:** `read_code`, `write_code`, `create_pr`, `review_pr`, `write_tests`, `decompose_task`, `manage_issues`, `approve`, `reject`, `vote`, `review_rfc`

**Available providers:** `anthropic`, `claude-code`, `cursor`, `antigravity`, `gemini`, `lmstudio`, `openai`, `ollama`, `local`

**`timeoutMs`** bounds one turn of a native agent (`claude-code`, `cursor`, `antigravity`): a single call that
reads, edits and runs the project's tests until it is done. The budget is the size of the tasks
that agent is given, not a property of the engine — a small fix finishes in minutes, a change
across several plugins with tests does not. A turn that reaches the limit is killed and the task
fails; its worktree is preserved. `FLOOR_AGENTS_AGENT_TIMEOUT_MS` overrides it for one run,
without editing the manifest.

**`maxTurns`** caps the tool calls in one turn, for a CLI that counts them (`claude-code`: every
Read, Edit or Bash call is a turn). The defaults fit the role — 300 implementing, 60 reviewing —
and a turn that reaches the cap ends with no result, reported as such. The time budget already
bounds a runaway turn, so the cap only needs to be larger than honest work.

**`antigravity`** seats Gemini through the Antigravity CLI (`agy`) on the Google AI Pro
subscription — no API key, no metering. `provider: gemini` remains the Gemini API adapter.
The native runner treats `antigravity` like `cursor`: an implementer gets
`--dangerously-skip-permissions` inside an implementer sandbox; a reviewer gets `--mode plan`
inside a reviewer sandbox. `--print-timeout` is set from `timeoutMs` so the CLI does not give
up before the engine does. List models with `agy models`. An external committee member with
`provider: antigravity` runs `scripts/agy-agent-bridge.ts`.

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
  privateSourceProviders:            # Providers trusted with private sources (absent: none)
    - claude-code
    - cursor
```

### `tasks`

Where the project's tasks live. Absent means GitHub issues in the project's own repository,
which needs no configuration. Secrets stay out of the manifest: the API key comes from the
project's `.agents/.env`.

```yaml
tasks:
  source: linear                     # linear | github-issues | things
  labels: [agent]                    # `watch` hands an issue with one of these to the implementer
  linear:
    team: FLO                        # team key or id
    project: vlist                   # project name or id; issues outside it are not this project's
```

`floor-agents run --issue FLO-31` then reads the Linear issue by its key. A PR for a task in a
private tracker references it as `Refs FLO-31` and never repeats its text; `Closes #n` is
written only for a public GitHub issue in the same repository.

Each turn, the implementer is given the issue's comments as a Discussion section: people's
notes and the engine's own reports (a stop report, a retry hint). Progress comments signed by
an implementer, reviewer or committee member are skipped, so the prompt is the conversation
rather than the run talking to itself. A failure to read comments is logged and the turn
continues without them.

### `review`

How an implementer's pull request is reviewed before a person (the coordinator) sees it. Merging is never automatic.

```yaml
review:
  committee: true                    # every agent with `vote` reviews the PR diff
```

**Default.** When `review` is omitted:

- a manifest that seats a `review_pr` agent keeps the single-reviewer path (that agent reviews alone)
- a manifest that seats voters and no `review_pr` agent turns committee PR review on

Set `review.committee: true` to send every implementer PR to the committee even when a `review_pr` agent is also seated. Set `review.committee: false` to skip committee review.

When committee PR review runs, each member with `vote` reads the PR diff (`getPRDiff`) inside its reviewer sandbox, returns findings and a vote (`VOTE: APPROVE` / `VOTE: REJECT`, with must-fix issues as `BLOCKER: …`), and the engine posts one signed PR comment per member plus one summary. The pipeline verdict is:

- **approve** — a majority of answers approve and no member found a blocker
- **changes requested** — otherwise; blockers are fed to the implementer as review comments, up to the usual review-cycle cap
- **no decision** — fewer than two members returned a vote (timeouts and errors abstain). The issue is left `in_review` for a person; there is no verdict

A member that times out or errors abstains and says so on the PR. Two answering votes are enough to decide, so one abstention in a four-member committee does not block a result.

### `sources`

Named material agents consult beside the repository. Paths are relative to the manifest.

```yaml
sources:
  findings:
    path: "../../docs/projects/vlist/findings.html"
    format: "html"
    visibility: "private"            # public | private; omitted means private
```

An agent whose `llm.provider` is not in `guardrails.privateSourceProviders` cannot read a private source: its sandbox denies the path. See [Private sources](./guides/sandbox.md#private-sources).

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
