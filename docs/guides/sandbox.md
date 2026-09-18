# Agent Sandbox

Agent CLIs run with your privileges. Their own permission flags do not keep them inside the folder you give them, so Floor Agents starts each agent process inside an operating-system sandbox written for that run.

## Why the CLIs' own flags are not enough

Measured on 2026-09-17 against `cursor-agent` (build 2025.10.02) with `cursor-grok-4.6-high`:

| how the agent ran | write inside its folder | file-edit tool writes outside | shell writes outside |
|---|---|---|---|
| `--trust` | ✓ | **✓ — a sibling folder and an absolute path** | ✗ refused |
| `--force` | ✓ | ✓ | ✓ |
| `--force` inside `sandbox-exec` | ✓ | ✗ `Write permission denied` | ✗ `operation not permitted` |

There is no read-only mode: `--trust` refuses shell commands but still lets the edit tool write anywhere. The same class of problem applies to Claude Code whenever `Bash` is allowed — a tool list of `Read, Glob, Grep, Bash` is not read-only. Containment therefore comes from the operating system, never from what the agent is asked or allowed to do.

A second trap, found by the enforcement test: macOS symlinks `/tmp` and `/var` into `/private`, and the sandbox matches resolved paths. A rule written against `/var/folders/…` silently never applied, and every write it was meant to stop went through. The sandbox package resolves every path before writing a rule.

## How it works

`@floor-agents/sandbox` builds a [sandbox profile](../packages/sandbox.md) for one run and starts the CLI as `sandbox-exec -p <profile> <cli> …`. Rules are evaluated last-match-wins:

1. allow everything by default;
2. **deny every write under your home directory**;
3. allow writes to the run's own folders and to the CLI's state directories;
4. **deny reads** of credential stores and `.env` files — placed last, so no allowance can reopen them.

| role | writable | example |
|---|---|---|
| **reviewer** | nothing but the CLI's own state | committee members reading the real checkout; the native PR reviewer |
| **implementer** | its worktree and that worktree's git metadata | the native agent in `run` and `watch` |
| **project command** | the worktree and package caches | setup and verification commands |

Project commands are contained because they execute code the agent may have written — its tests, a `postinstall` script. Sandboxing only the agent would let it plant a test that the engine then runs with your full access.

A reviewer needs no copy of the repository: it reads your checkout directly, and every write to it fails.

### The CLIs' state directories

These stay writable so the CLI can authenticate and keep its session:

| CLI | under home |
|---|---|
| `cursor-agent` | `.cursor`, `.local/share/cursor-agent`, `Library/Application Support/Cursor`, `Library/Caches` |
| `claude` | `.claude`, `.claude.json` (and its lock and backup files), `Library/Caches` |
| `codex` | `.codex`, `Library/Caches` |
| project commands | `.bun`, `.npm`, `.cache`, `Library/Caches`, `.cargo/registry`, `.cargo/git`, `go/pkg/mod` |

### Unreadable by default

`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.docker`, and any `.env`, `.env.local`, `.env.*` file anywhere on disk.

### Private sources

A manifest can name sources beside the repository and mark them private, and list the providers trusted with them:

```yaml
sources:
  findings:
    path: "../../docs/projects/vlist/findings.html"   # relative to the manifest
    visibility: "private"                              # the default when omitted

guardrails:
  privateSourceProviders: [claude-code, cursor]
```

Whatever an agent reads becomes part of a prompt sent to its provider, so the list names companies trusted with the material, not tools. Every agent whose `llm.provider` is **not** listed runs with each private source added to its read denials — the native implementer and reviewer, the in-process Claude and Cursor adapters, and the Cursor and Codex committee bridges, which receive the paths through `FLOOR_AGENTS_DENY_READ`. Without `privateSourceProviders`, no provider is trusted.

Two bridges cannot be sandboxed: the xAI `grok` CLI and Antigravity. An external agent on either, when its provider is not trusted, stops the committee run before any process starts.

`floor-agents doctor` checks each private path exists — a denial on a mistyped path protects nothing while the real file stays readable — and fails when an untrusted agent is seated while `FLOOR_AGENTS_SANDBOX=off`.

Only the declared paths are denied. A private repository's other files stay readable unless they are declared too; a source may be a directory.

## Configuration

| variable | effect |
|---|---|
| `FLOOR_AGENTS_DENY_READ` | extra unreadable paths, comma-separated, `~` expanded — e.g. `~/Code/private-notes,/srv/secrets`. Denied to every agent in the run; for per-provider denial, declare [private sources](#private-sources) instead. |
| `FLOOR_AGENTS_SANDBOX_WRITABLE` | extra writable paths for implementers and project commands — e.g. `~/.gradle` for a build that caches elsewhere. Reviewers never gain writable paths. |
| `FLOOR_AGENTS_SANDBOX=off` | run agents uncontained. For developing Floor Agents itself; never for agents on a real repository. |

## What the sandbox does not contain

- **Reads outside the deny list.** An agent can read anything else you can read, and whatever it reads becomes part of a prompt sent to its model provider. Deny what matters with [private sources](#private-sources) or `FLOOR_AGENTS_DENY_READ`.
- **Network access.** The CLI must reach its provider; nothing restricts where else it connects.
- **Time and CPU.** Bounded by each adapter's timeout, not by the sandbox.
- **Your keychain.** CLIs authenticate through system services the file rules do not govern.

## Platform

`sandbox-exec` is macOS-only. Everywhere else the adapters **refuse to start an agent** rather than run it uncontained, unless `FLOOR_AGENTS_SANDBOX=off` is set. Apple marks `sandbox-exec` deprecated; it works on current macOS and has no command-line replacement, so a future macOS release could require a different mechanism.

## What is sandboxed today

| path | sandboxed |
|---|---|
| Cursor committee bridge (`scripts/cursor-agent-bridge.ts`) | ✓ reviewer |
| Claude in-process committee reviewer (`committee-run`, `discussion-committee`, `decision-committee`, `committee-smoke`) | ✓ reviewer |
| `@floor-agents/cursor` adapter | ✓ always — the sandbox is a required option |
| `@floor-agents/claude-code` adapter | when a `sandbox` is passed |
| Native implementer in `run` / `watch` — `claude-code` or `cursor` | ✓ implementer |
| Native PR reviewer | ✓ reviewer |
| Project setup and verification commands | ✓ project command |
| Codex bridge (`scripts/codex-agent.ts`) | ✓ reviewer — Codex's own sandbox turned off, see below |
| xAI Grok bridge, Antigravity relay | ✗ — refused when a private source must be denied to them |

Codex applies its own sandbox with `sandbox-exec` around each shell command, and a sandboxed process may not apply another: inside ours, `codex exec --sandbox read-only` fails every command with `sandbox_apply: Operation not permitted`. So the bridge runs `--sandbox danger-full-access` inside our reviewer sandbox, which does the containing. Measured live: Codex read the repository, and both a write under home and a read of a denied file failed with `Operation not permitted`. With `FLOOR_AGENTS_SANDBOX=off` the bridge keeps `--sandbox read-only`.

Measured live with the native runner and `cursor-grok-4.6-high` in a worktree: it edited a file there and ran `git status` through the shell (the worktree's git metadata is writable), while creating a file under the home directory failed with `Write permission denied`. The main checkout the worktree came from was untouched.

## Verifying

Two enforcement tests run where `sandbox-exec` can actually apply a profile, and are skipped where it cannot (other platforms, or nested inside the engine's own verification — macOS refuses to nest `sandbox-exec`):

- `test/sandbox` — a profile's effect: a write outside the allowed folder fails, a write inside it succeeds, a denied file cannot be read, and a denied private source cannot be read while the repository beside it can.
- `test/orchestrator/native-runner.test.ts` — the native launch path: fake `cursor-agent` and `claude` scripts first on `PATH` try to write inside and outside their folder; the implementer writes only its worktree, the reviewer writes nothing, and a private source passed as a denial cannot be read.

The skip uses `sandboxAvailable()` in `test/helpers/sandbox.ts`, which probes `sandbox-exec` once rather than trusting `Bun.which`. `test/orchestrator/verified-project.test.ts` runs the whole verified-execution suite with project commands sandboxed where that works, and sets `FLOOR_AGENTS_SANDBOX=off` where it cannot, so the pipeline still exercises verification logic uncontained.
