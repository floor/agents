# @floor-agents/sandbox

Operating-system containment for agent CLIs on macOS. Builds a `sandbox-exec` profile for one run and wraps the command in it. See the [Agent Sandbox guide](../guides/sandbox.md) for why it exists and what it does and does not contain.

## Structure

```
packages/sandbox/src/
├── index.ts       ← re-exports
└── sandbox.ts     ← profiles, role presets, sandboxed()
```

## Usage

```typescript
import { reviewerSandbox, implementerSandbox, sandboxed } from '@floor-agents/sandbox'

// A committee reviewer: reads the repository, writes nothing but its CLI state.
const argv = sandboxed(['cursor-agent', '-p', prompt], reviewerSandbox('cursor'))
Bun.spawn(argv, { cwd: repo })

// An implementer: may also write its worktree and that worktree's git metadata.
const spec = implementerSandbox('claude', [worktreePath, worktreeGitDir])
```

## API

| export | purpose |
|---|---|
| `reviewerSandbox(tool, env?, home?)` | spec with no writable folders |
| `implementerSandbox(tool, writable, env?, home?)` | spec that may write the given folders |
| `projectCommandSandbox(writable, env?, home?)` | spec for setup and verification commands: the given folders plus package caches |
| `sandboxed(argv, spec, opts?)` | `['sandbox-exec', '-p', profile, ...argv]`; throws where the sandbox is unavailable unless `FLOOR_AGENTS_SANDBOX=off` |
| `withDenyRead(spec, paths)` | the same spec with more unreadable paths — private sources an untrusted provider may not read |
| `denyReadEnv(paths, env?)` | `FLOOR_AGENTS_DENY_READ` for a child process that builds its own sandbox, merged with the value already set; refuses a path containing a comma |
| `sandboxProfile(spec)` | the SBPL profile text |
| `toolState` | writable state directories per CLI (`cursor`, `claude`, `codex`, `antigravity`) |
| `DEFAULT_DENY_READ`, `DENY_READ_PATTERNS` | credential stores and `.env` files denied to every run |

`tool` is `'cursor'`, `'claude'`, `'codex'`, `'antigravity'` or `'project'` and decides which state directories stay writable. Specs resolve every path with `realpath`, because the sandbox matches resolved paths and macOS symlinks `/tmp` and `/var`.

## Environment

| variable | effect |
|---|---|
| `FLOOR_AGENTS_DENY_READ` | extra unreadable paths, comma-separated, `~` expanded |
| `FLOOR_AGENTS_SANDBOX_WRITABLE` | extra writable paths for implementers and project commands |
| `FLOOR_AGENTS_SANDBOX=off` | return the command unwrapped |
