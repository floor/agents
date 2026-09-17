# @floor-agents/cursor

LLM adapter that runs a headless `cursor-agent -p` turn on the **Cursor subscription**. One adapter reaches every model Cursor offers — Grok, GPT, Gemini, Claude — with no vendor API key. `provider: cursor` names this transport; the model string names the model.

## Structure

```
packages/cursor/src/
├── index.ts       ← re-exports
└── adapter.ts     ← createCursorAdapter, buildCursorArgs, parseCursorResult
```

## Usage

```typescript
import { createCursorAdapter } from '@floor-agents/cursor'
import { reviewerSandbox } from '@floor-agents/sandbox'

const adapter = createCursorAdapter({
  cwd: '/path/to/repo',
  model: 'cursor-grok-4.6-high',
  sandbox: reviewerSandbox('cursor'),   // required
})
```

## Config in YAML

```yaml
agents:
  - id: grok
    name: "Grok"
    llm:
      provider: cursor
      model: cursor-grok-4.6-high     # effort is part of the id: -low | -medium | -high | -xhigh (+ -fast)
```

List identifiers with `cursor-agent --list-models` (requires `cursor-agent login`).

## As a native implementer

`cursor` is a native provider: an agent with `provider: cursor` and `write_code` implements through the native runner, like `claude-code`. It runs on a worktree with `--force` (it needs the shell for tests) inside an implementer sandbox — it may write that worktree and its git metadata, nothing else — and the engine verifies and publishes the tree. As a PR reviewer it runs with `--trust` in a reviewer sandbox.

## Configuration

| option | default | description |
|---|---|---|
| `sandbox` | — (required) | the [sandbox](./sandbox.md) every run starts in; there is no uncontained mode |
| `cwd` | `process.cwd()` | working directory — `cursor-agent` has no `--cwd` flag |
| `model` | CLI default | model identifier, passed verbatim |
| `allowShell` | `false` | `--force` (shell commands approved) instead of `--trust` |
| `timeoutMs` | 600000 | kill the turn after this long |
| `bin` | `cursor-agent` | CLI binary |

## Flags are not containment

The CLI requires a consent flag. Measured: `--trust` refuses shell commands but still lets the file-edit tool write outside the working directory, including to absolute paths; `--force` also approves shell commands. `allowShell` only chooses between them. Writes are confined by `sandbox`, which is why it is required.

## Billing

`CURSOR_API_KEY` is removed from the child environment so the run uses the logged-in subscription rather than metered API auth. The JSON envelope reports token counts but no price, so `usage.cost` is `0`.

## Completion is not the agent's word

A headless turn can end having written nothing and still return `is_error: false`. The adapter surfaces no tool calls; callers that need to know whether work happened inspect the workspace (`commitWorktree` returns `null` for an unchanged tree), and the committee bridge retries a reply that carries no verdict.
