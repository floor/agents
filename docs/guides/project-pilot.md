# A verified task in your own project

The first project workflow is a single issue → isolated checkout → engine checks → PR.
It supports native Claude Code and API developers. The engine runs the checks itself,
records their exit codes and output, and publishes only the Git tree that passed.

## Initialize

From the target repository, using your locally built `floor-agents` binary:

```sh
floor-agents init
```

This writes `.agents/agents.yaml` and `.agents/developer.md`. It reads the Git origin
and available project scripts; it does not install dependencies, invoke an agent,
or overwrite existing files. Review the inferred base branch and commands. If the
stack has no recognized checks, add them before continuing.

Example for a Node project (the target application does not require Bun):

```yaml
name: my-app
project:
  name: my-app
  owner: my-org
  repo: my-app
  root: ..                    # relative to this manifest in .agents/
  baseBranch: main
  language: typescript
  runtime: node
  setup:
    - name: Install dependencies
      command: [npm, ci]
      timeoutMs: 300000
  verification:
    - name: Typecheck
      command: [npm, run, typecheck]
    - name: Tests
      command: [npm, test]
    - name: Build
      command: [npm, run, build]

agents:
  - id: developer
    name: Developer
    promptTemplate: ./developer.md
    llm:
      provider: claude-code
      model: sonnet
      maxTokens: 16000
    capabilities: [read_code, write_code, write_tests, create_pr]
    autonomy: T1
    timeoutMs: 1800000          # one turn's budget; default is ten minutes

guardrails:
  maxFilesPerTask: 20
  maxFileSizeBytes: 102400
  maxTotalOutputBytes: 512000
  blockedPaths: ['.env*', '**/.env*', '**/*.pem', '**/*.key', '.github/workflows/**', '.agents/**']
```

Commands are argument arrays executed directly in the isolated checkout. Shell
operators are not expanded. Configure a script or an explicit shell command when
needed. Each command defaults to a five-minute timeout. Use one-shot test commands;
watch mode will reach the timeout. Setup runs before the agent and again in a
reviewer's checkout when a reviewer is configured.

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to watch a run from a phone: each
comment the run posts on its issue — picked up, working, the diffstat, the
verification results, the PR — is repeated in that chat. The issue stays the
record; a chat that cannot be reached is logged and the run continues.

Add `.worktrees/` and `.agents/runs/` to the project's `.gitignore`. Commit the
manifest and developer prompt if your team should share them. Keep credentials
in your environment. The generated manifest starts with one developer; add a
`review_pr` agent for an independent model review after engine verification.

## Preflight and run

Set `GITHUB_TOKEN`, authenticate your native Claude Code CLI, and ensure local Git
can fetch and push the repository. API providers instead need their corresponding
keys. GitHub API access and Git's SSH/HTTPS authentication are separate.

```sh
floor-agents doctor
floor-agents run --issue 123
```

`doctor` and `run` default to GitHub Issues. Use `TASK_ADAPTER=linear` with
`LINEAR_API_KEY` and `LINEAR_TEAM_ID` for Linear. A one-shot run needs no trigger
label and exits successfully only when the pipeline reaches its completion state.
It creates a PR for human review; it does not merge it. A config containing voting
agents belongs to committee mode and is rejected by `run`.

`doctor` checks manifest validity, prompt files, checkout/origin identity, base
branch access, local Git identity, executable availability, GitHub repository
access, and required credential presence. It does not run setup/check commands or
spend model tokens. Provider login/model access and actual Git push permissions
are exercised during execution, not certified by preflight.

Run from another directory using an explicit manifest:

```sh
floor-agents run --config /path/to/my-app/.agents/agents.yaml --issue 123
```

The checkout and prompt paths resolve relative to that file. The service launch
directory does not choose which repository receives the changes.

## What a pass establishes

Both native and configured API execution validate the cumulative diff, including
blocked deletions, file counts, binary sizes and file modes. Symlinks and submodule
changes are rejected by the native diff validator. Checks capture up to 32 KiB per
stdout/stderr stream, continue draining larger output, and record truncation.
Timeouts fail; on POSIX, the check's process group is terminated as well.

The candidate Git tree must remain unchanged through verification and commit.
The published commit contains that verified tree; intermediate commits created
by an agent are excluded. The engine checks the remote branch against the verified
commit before opening the PR, reviewing, and completing. This is evidence for
that commit, not a guarantee that future human pushes remain verified.

Worktrees isolate Git changes; the [agent sandbox](./sandbox.md) contains the
processes. On macOS a native implementer may write only its worktree and that
worktree's git metadata, a native reviewer writes nothing, and project setup and
checks — which run code the agent wrote — may write only the worktree and package
caches. Credential stores and `.env` files are unreadable to all of them. Reads
elsewhere and network access are not contained, and on other platforms native
runs are refused unless `FLOOR_AGENTS_SANDBOX=off`. The diff gate still controls
what the engine publishes.

## Inspect a failure

Execution state defaults to `runs/` beside the manifest; override it with
`STATE_DIR`. Each issue's JSON contains `verification` (checks, exit codes, logs,
tree/commit IDs) and `workspacePath`. A failed check, blocked diff, native error,
or push failure leaves the developer workspace available for inspection and
labels the issue `needs-human`. Successful developer workspaces are removed.

`run` refuses to overwrite an existing execution state, including a failed one.
Dedicated retry/resume/cancel commands and durable attempt scheduling remain a
separate increment. Do not delete state merely to retry a published task; inspect
the recorded branch and PR first.

## Existing configurations

- `project.root` and every `promptTemplate` now resolve relative to the manifest.
  For a config in `config/templates/`, use `../../agents/backend-dev.md`, not
  `agents/backend-dev.md`.
- Native development requires an explicit root and nonempty verification commands.
  The shipped developer template includes setup, typecheck and test commands.
- Legacy API library/watch workflows without `project.verification` still use the
  remote-only path and do not have engine test evidence. `run` requires verification.
- The default state directory changed from `./data/executions` to `runs/` beside the
  manifest. Existing services should keep `STATE_DIR` pointed at their current
  state directory to preserve recovery and deduplication.
- YAML workflow/PM/QA orchestration and autonomy-tier enforcement are not added by
  this increment. The active implementation flow remains developer → optional
  reviewer, with deterministic checks before publication.

## Pilot acceptance

Use a small issue with clear behavior and a regression test. Record the PR,
verification result, duration, and manual intervention. Automated integration
coverage uses a separate temporary checkout and bare remote, tests successful
publication, and injects failing checks, blocked changes, timeouts, and stale
verification. A real provider/GitHub pilot and forced process-restart recovery are
additional validations; the local fixture does not establish either.
