# CLI

`@floor/agents` ships a `floor-agents` binary that runs the orchestrator from a
config + environment. Requires [Bun](https://bun.sh).

```bash
bunx @floor/agents --help       # or, installed: floor-agents --help
```

## Flags

| Flag | Description |
|------|-------------|
| `--help`, `-h` | Show usage and exit |
| `--version`, `-v` | Print the version and exit |

With no flags, it loads the config, picks a mode (below), and starts watching for work.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_PATH` | — (**required**) | Path to the team config YAML. Without it (and no local `config/templates/default.yaml`) the CLI exits with a clear message. |
| `TASK_ADAPTER` | `linear` | Task source: `linear` \| `things` \| `github-issues` |
| `COMMITTEE_LABELS` | `committee,agents` | Comma-separated tags that trigger a committee review |
| `STATE_DIR` | `./data/executions` | Where execution state is persisted |
| `GATEWAY_PORT` | `3100` | Port for the external-agent gateway (started only when the config has external agents) |
| `GATEWAY_TOKEN` | — | Optional gateway auth token |

Plus credentials, **only for what your config uses**:

| Variable | Needed for |
|----------|-----------|
| `GITHUB_TOKEN`, `GITHUB_OWNER` | always (the git adapter) |
| `LINEAR_API_KEY`, `LINEAR_TEAM_ID` | `TASK_ADAPTER=linear` |
| `GITHUB_ISSUES_REPO` | `TASK_ADAPTER=github-issues` |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` / `LMSTUDIO_BASE_URL` | the providers your **internal** agents use (external agents need no key) |

## Modes

The mode is auto-detected from the config:

- **Committee** — when any agent has the `vote` capability. Review-only: agents review a
  proposal in parallel and vote APPROVE/REJECT; majority wins. Triggered by the
  `COMMITTEE_LABELS` tags (default `committee`, `agents`) on a task.
- **Dev** — otherwise. The pipeline writes code and opens PRs (PM → dev → CTO review →
  QA). Triggered by the config's workflow trigger label.

## Trigger tags

In committee mode, the CLI watches your task source for any task tagged with one of
`COMMITTEE_LABELS` (default `committee` **or** `agents`) and runs a review. Example:

```bash
COMMITTEE_LABELS=committee,agents,rfc floor-agents   # add more tags
```

## Examples

Committee review with the local trio (Claude Code + Codex + Antigravity) over Things:

```bash
CONFIG_PATH=~/Code/floor/.agents/projects/vlist/agents.yaml \
TASK_ADAPTER=things GATEWAY_PORT=3199 \
floor-agents
```

External agents connect separately — see the [Local Committee guide](./guides/local-committee.md).

Dev pipeline over Linear:

```bash
CONFIG_PATH=./.agents/agents.yaml TASK_ADAPTER=linear \
LINEAR_API_KEY=… LINEAR_TEAM_ID=… GITHUB_TOKEN=… GITHUB_OWNER=your-org \
floor-agents
```

## See also

- [Committee Mode](./guides/committee.md) · [Local Committee](./guides/local-committee.md)
- [Configuration](./configuration.md) — the team config YAML
- [Scripts](./scripts.md) — the gateway bridges external agents run
