# @floor-agents/antigravity

LLM adapter that runs a headless `agy -p` turn on the **Google AI Pro subscription** via the Antigravity CLI. `provider: antigravity` names this transport; the model string is what `agy models` lists (`gemini-3.1-pro-high`). The Gemini **API** adapter (`provider: gemini`) stays for API keys.

## Structure

```
packages/antigravity/src/
├── index.ts       ← re-exports
└── adapter.ts     ← createAntigravityAdapter, buildAgyArgs, parseAgyResult
```

## Usage

```typescript
import { createAntigravityAdapter } from '@floor-agents/antigravity'
import { reviewerSandbox } from '@floor-agents/sandbox'

const adapter = createAntigravityAdapter({
  cwd: '/path/to/repo',
  model: 'gemini-3.1-pro-high',
  sandbox: reviewerSandbox('antigravity'),   // required
})
```

## Config in YAML

```yaml
agents:
  - id: gemini
    name: "Gemini"
    llm:
      provider: antigravity
      model: gemini-3.1-pro-high     # also gemini-3.1-pro-low, gemini-3.8-flash-{high,medium,low}, …
```

List identifiers with `agy models` (requires the CLI login). Optional `--effort low|medium|high` is a separate flag, not part of the model id.

## As a native implementer

`antigravity` is a native provider: an agent with `provider: antigravity` and `write_code` implements through the native runner, like `cursor` and `claude-code`. It runs on a worktree with `--dangerously-skip-permissions` (it needs the shell for tests) inside an implementer sandbox — it may write that worktree and its git metadata, nothing else — and the engine verifies and publishes the tree. As a PR reviewer it runs with `--mode plan` in a reviewer sandbox.

The native implementer's prompt never names the API-path tools (`write_file`, `pr_description`) as things to use: agy's file tool is itself called `write_file`, and a prohibition on that name made Gemini print whole files and write nothing (mtrl FLO-102). The context builder omits the API Output section and the matching role-template bullets (`native: true`), leaving unrelated instructions intact; native instructions tell the CLI to edit the working tree with its own tools and not to print file contents as a reply.

`--print-timeout` is set from the agent's `timeoutMs` (a Go duration, e.g. `10m`) so the CLI does not give up before the engine does. A CLI-side timeout is reported as a budget, not a crash.

## Configuration

| option | default | description |
|---|---|---|
| `sandbox` | — (required) | the [sandbox](./sandbox.md) every run starts in; there is no uncontained mode |
| `cwd` | `process.cwd()` | working directory — `agy` has no `--cwd` flag |
| `model` | CLI default | model identifier, passed verbatim |
| `role` | `review` | `review` → `--mode plan`; `implement` → `--dangerously-skip-permissions` |
| `effort` | omitted | `--effort low\|medium\|high` when set |
| `timeoutMs` | 600000 | kill the turn after this long; also passed as `--print-timeout` |
| `bin` | `agy` | CLI binary |

## Flags are not containment

`--mode plan` is read-only at the tool-permission layer. `--dangerously-skip-permissions` auto-approves tools, including the shell. agy's own `--sandbox` is not relied on. Writes are confined by `sandbox`, which is why it is required.

## Billing

`GEMINI_API_KEY` and `GOOGLE_API_KEY` are removed from the child environment so the run uses the logged-in subscription rather than metered API auth. The JSON envelope reports token counts but no price, so `usage.cost` is `0`.

## Completion is not the agent's word

A headless turn can end having written nothing and still return `status: SUCCESS`. The adapter surfaces no tool calls; callers that need to know whether work happened inspect the workspace (`commitWorktree` returns `null` for an unchanged tree), and the committee bridge retries a reply that carries no verdict.

## Login

The CLI reads its Google login from `~/.gemini` (`oauth_creds.json` and neighbours). `floor-agents doctor` checks that `agy` is on `PATH`.
