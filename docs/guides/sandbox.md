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
| **reviewer** | nothing but the CLI's own state | committee members reading the real checkout |
| **implementer** | its worktree and that worktree's git metadata | `run --issue` (see status below) |

A reviewer needs no copy of the repository: it reads your checkout directly, and every write to it fails.

### The CLIs' state directories

These stay writable so the CLI can authenticate and keep its session:

| CLI | under home |
|---|---|
| `cursor-agent` | `.cursor`, `.local/share/cursor-agent`, `Library/Application Support/Cursor`, `Library/Caches` |
| `claude` | `.claude`, `.claude.json` (and its lock and backup files), `Library/Caches` |

### Unreadable by default

`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.docker`, and any `.env`, `.env.local`, `.env.*` file anywhere on disk.

## Configuration

| variable | effect |
|---|---|
| `FLOOR_AGENTS_DENY_READ` | extra unreadable paths, comma-separated, `~` expanded — e.g. `~/Code/private-notes,/srv/secrets`. Use it for private sources a hosted model must not see. |
| `FLOOR_AGENTS_SANDBOX=off` | run agents uncontained. For developing Floor Agents itself; never for agents on a real repository. |

## What the sandbox does not contain

- **Reads outside the deny list.** An agent can read anything else you can read, and whatever it reads becomes part of a prompt sent to its model provider. Deny what matters with `FLOOR_AGENTS_DENY_READ`.
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
| Native implementer in `run` / `watch` (`native-runner.ts`) | **not yet** |
| Codex bridge | its own `codex exec --sandbox read-only` |

## Verifying

`bun test test/sandbox` includes an enforcement test that runs on macOS: it builds a profile around a temporary home directory, then checks that a write outside the allowed folder fails, a write inside it succeeds, and a denied file cannot be read. On other platforms it is skipped.
