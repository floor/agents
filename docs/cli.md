# CLI

`floor-agents` requires Bun and runs from a project manifest and environment.
See the [project pilot guide](./guides/project-pilot.md) for a complete setup.

```sh
floor-agents init
floor-agents doctor
floor-agents run --issue 123
floor-agents status --issue 123
floor-agents verify --issue 123
```

| Command | Behavior |
|---------|----------|
| `init` | Create `.agents/agents.yaml` and a developer prompt; infer origin, base branch and project commands; never overwrite existing files |
| `doctor` | Check config, repository identity/access, command availability, prompts and credential presence without invoking an agent |
| `run --issue <id>` | Implement one issue, run configured checks, create a PR, then exit; refuses an existing execution state |
| `run --issue <id> --retry` | Archive a failed attempt under `STATE_DIR/archive/`, drop the `needs-human` label, and run the issue again; refuses an attempt that is not failed. The new run starts over from the base but carries the issue's history: attempts and reviews keep their numbering |
| `verify --issue <id>` | Take the last attempt's preserved tree forward without another agent turn: guardrails and the whole gate again, and on green the usual publication — commit, push, pull request, review. For stops that were not the code's fault (a guardrail since raised, a flaky check, a budget reset). Refuses when the run is not failed, when the attempt kept no tree, or when the branch has moved since the attempt began; a tree that fails again stays kept and the issue is told which check failed |
| `review --issue <id>` | Seat the committee again on the issue's pull request, when its last review ended with **no decision** — a seat out of quota, a bridge that could not start. No agent turn, no gate: the pipeline is entered at its review step, checks that the pull request still carries the verified commit, and goes on from the verdict as any run does (a revision on a rejection, done on an approval). Also reopens a loop that stopped on a **blocker which stood through a revision**, once a person has settled the point in a comment on the issue. Otherwise it refuses: a run that is not done, no pull request, or a last review that reached a verdict — a verdict is not reopened by asking again |
| `status --issue <id>` | Print the issue's history: each implementer turn (agent, turn time, outcome, the gate step that failed and the end of what it printed, whether its tree is still on disk) and each review cycle with its votes |
| `watch` or no command | Start the existing developer or committee watch loop |
| `--help`, `-h` | Show usage |
| `--version`, `-v` | Show version |
| `--config <path>` | Select the project manifest for any command |

Config discovery: `--config`, then `CONFIG_PATH`, then `.agents/agents.yaml`, then
`config/templates/default.yaml` for source development. Unknown arguments fail.

| Environment | Default / purpose |
|-------------|-------------------|
| `TASK_ADAPTER` | `github-issues` for `run`/`doctor`, `linear` for `watch`; also supports `things` |
| `STATE_DIR` | `runs/` beside the manifest; existing installations should explicitly retain their previous state directory |
| `GITHUB_TOKEN` | Required for GitHub API access |
| `GITHUB_OWNER` | Overrides `project.owner` |
| `GITHUB_ISSUES_REPO` | Overrides `project.repo` for the GitHub task source |
| `LINEAR_API_KEY`, `LINEAR_TEAM_ID` | Required for Linear |
| `LINEAR_PROJECT_ID` | Optional Linear project scope |
| Provider credentials | Required only for configured internal providers |
| `COMMITTEE_LABELS` | Comma-separated committee triggers; default `committee,agents` |
| `GATEWAY_PORT` | External-agent gateway port; default `3100` |
| `GATEWAY_TOKEN` | Optional gateway authentication token |
| `FLOOR_AGENTS_RESUME` | `off` makes a revision start a new agent session with the full brief instead of continuing the implementer's own; default is to continue |

`run` supports development configs. It requires `project.root`, `project.baseBranch`,
and nonempty `project.verification`. It runs preflight first and exits nonzero if
setup, execution, checks, publication or completion fails. It never merges a PR.

`watch` retains automatic mode detection: any agent with `vote` selects committee
mode; otherwise it uses the developer/reviewer flow triggered by `agent`. PM and
QA workflow integration is not active. A configured verification pipeline runs
preflight at service startup, too.

Developer commands and prompt paths are project-specific; paths resolve relative
to the manifest, not the launch directory. Missing prompts fail preflight rather
than silently degrading the new one-shot workflow.

```sh
TASK_ADAPTER=linear floor-agents doctor --config /path/to/project/agents.yaml
TASK_ADAPTER=linear floor-agents run --config /path/to/project/agents.yaml --issue FLO-123
```

Provider preflight checks presence, not model inference or login validity. GitHub
API repository access does not establish local Git push authentication. Detailed
verification output and preserved failure workspaces are described in the
[project pilot guide](./guides/project-pilot.md).
