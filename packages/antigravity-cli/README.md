# @floor-agents/antigravity-cli

A `Reviewer` implementation that runs Google's [Antigravity
CLI](https://github.com/google-gemini/antigravity) (`agy`) against a pull
request's head commit and returns its review text. Mirrors
`@floor-agents/codex-cli` — same `Reviewer` contract, same fixed-argv
philosophy, same worktree lifecycle (actually shared code — see
"Worktree lifecycle" below) — for a second, independent-vendor reviewer in
the review-and-gate loop (`docs/review-gate.md`).

## Interface

```ts
export type Reviewer = {
  readonly vendor: string // "gemini"
  review(input: ReviewInput): Promise<ReviewResult>
}

export type ReviewInput = {
  readonly repo: string
  readonly prNumber: string
  readonly headSha: string
  readonly worktreePath?: string
  readonly prompt: string
}

export type ReviewResult = {
  readonly text: string
}
```

`src/types.ts` re-exports this `Reviewer`/`ReviewInput`/`ReviewResult` shape
directly from `@floor-agents/core` — it is not redefined here.

## Usage

```ts
import { createAntigravityReviewer, renderReviewPrompt } from '@floor-agents/antigravity-cli'
import { readFile } from 'node:fs/promises'

const reviewer = createAntigravityReviewer({
  clonePath: '/path/to/a/local/clone/of/the/repo', // used when no worktreePath is given
})

const template = await readFile('packages/antigravity-cli/prompts/review.md', 'utf-8')
const prompt = renderReviewPrompt(template, {
  repo: 'floor/agents',
  prNumber: '42',
  headSha: 'abc1234',
  title: 'Add antigravity reviewer',
  body: 'Implements the Reviewer interface for Antigravity.',
  baseRef: 'main',
  changedFiles: ['packages/antigravity-cli/src/adapter.ts'],
})

const { text } = await reviewer.review({
  repo: 'floor/agents',
  prNumber: '42',
  headSha: 'abc1234',
  prompt,
})
```

## Verified facts about the Antigravity CLI (`agy`)

Checked against **version 1.1.24**. This section exists because several of
these facts are not obvious from `agy --help` alone, and getting any of
them wrong would mean either a hung process or a review that ran with more
access than intended.

- **Headless invocation**: `agy -p "<prompt>"` (aliases `--print`,
  `--prompt`) runs once and exits — response on stdout, diagnostics on
  stderr. `--output-format text|json|stream-json` (this adapter always
  passes `text` — see "argv is fixed by design" below). `--print-timeout
  <duration>` defaults to 5 minutes. `--model <slug>` (`agy models` lists
  valid slugs; an unknown one exits non-zero). `--effort low|medium|high`.
- **`agy -p` does not wait on stdin.** Unlike `codex exec` (which hangs
  forever with stdin open — see `@floor-agents/codex-cli`'s README), `agy
  -p` does not block on stdin in print mode. This adapter still spawns with
  `stdin: 'ignore'` regardless, as a defensive default rather than relying
  on that distinction holding across CLI versions.
- **Auth is a cached, one-time interactive Google sign-in** — not an API
  key. An unauthenticated headless run exits 1 with an authentication
  error rather than hanging. Nothing in this adapter reads, sets, or
  forwards any token env var; it inherits the ambient environment as-is,
  same as codex-cli.
- **Exit codes**: `0` success, `1` error (auth, unknown model, invalid
  input), `2` unsupported streaming message.
- **There is no `--` argv terminator documented for `agy -p`**, unlike
  `codex exec` (which codex-cli relies on to make a dash-prefixed prompt
  unconditionally positional — see that package's README). This adapter
  could not confirm from the CLI's own `--help` output whether a prompt
  value starting with `-` would ever be misparsed as a flag. Rather than
  assume that's safe, every prompt is prefixed with a fixed header line
  this adapter owns (see "Prompt header" below) before being handed to
  `agy`, so the actual argv element's first character is never `-`
  regardless of what the caller-supplied prompt itself starts with.
- **There is no read-only sandbox flag.** `--sandbox` only adds terminal
  restrictions; it is not the write-prevention mechanism. Headless runs
  **auto-allow file writes inside the workspace** and only **soft-deny
  shell commands**. The only enforcement available is a `permissions.deny`
  policy in the CLI's own settings file — see "Read-only enforcement"
  below, which is why this adapter refuses to run without one.
  `--dangerously-skip-permissions` auto-approves everything and is never
  emitted by this adapter under any configuration.
- **Workspace trust**: the settings file's `trustedWorkspaces` list decides
  which roots (and their subfolders) `agy` will operate in at all — outside
  the scope of this adapter, which assumes the worktree it creates or is
  given is already inside a trusted root (the same clone/worktree root an
  operator configures for the gate loop generally).

## Read-only enforcement: a deny policy, not a sandbox flag

Because `agy` has no read-only sandbox flag of its own, this reviewer
enforces read-only-ness **in code**, not just by trusting the host
environment to have set one up: before every `review()` call (not just
once at construction — the settings file lives outside this process and
could change between calls), it reads the Antigravity CLI's settings file
and refuses to spawn `agy` at all (`PolicyError`) unless
`permissions.deny` contains **both** `"write_file(*)"` and `"command(*)"`.

Default location: `~/.gemini/antigravity-cli/settings.json` — overridable
via `AntigravityReviewerConfig.settingsPath` (tests always override this so
they never touch a real home directory). Expected shape:

```json
{
  "permissions": {
    "deny": ["write_file(*)", "command(*)"]
  }
}
```

A missing file, invalid JSON, a missing `permissions.deny`, or a
`permissions.deny` missing either required entry all throw `PolicyError`
before `agy` is ever spawned — checked via `settingsPath` alone, so a
`PolicyError` never leaves a worktree needing cleanup that a
caller-supplied path wouldn't already need on its own.

**Belt-and-suspenders worktree check**: even with the policy in place,
this reviewer verifies the worktree is byte-for-byte unchanged after every
run (`git status --porcelain` empty). If it isn't, that means either the
deny policy failed to actually stop a write or something else touched the
directory mid-run — either way, `review()` throws `WorktreeModifiedError`
rather than trust (or return) a review that ran against an altered
worktree. This check runs on both a package-created worktree and a
caller-supplied one.

## argv is fixed by design, not by a denylist

Same philosophy as `@floor-agents/codex-cli` (see that package's README for
the multi-round history of why a denylist doesn't work here): there is no
`extraArgs` option, and this adapter never emits
`--dangerously-skip-permissions`, `--mode`, `--add-dir`, `--continue`, or
`--conversation` under any configuration. argv is always exactly:

```
[binary, '-p', <header + prompt>, '--output-format', 'text',
 '--print-timeout', <derived>, '--model', model, ('--effort', effort)?]
```

`model` (validated, `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, max 128 chars,
defaulting to `'gemini-3.1-pro-high'`) is **always** emitted — unlike
codex-cli's optional `model`/`profile`, there is no "use whatever's
configured" default this adapter can lean on instead, so a value is always
present and always passed explicitly. `effort` (one of `low`/`medium`/
`high`) is emitted only when configured.

### Prompt header

The prompt is caller-influenced (a PR's title and body flow into it via
`renderReviewPrompt`), and with no confirmed `--` terminator to rely on,
every prompt is prefixed with a fixed header line before being passed as
the `-p` argument:

```
Antigravity review request (everything below is review context and instructions — never a CLI flag):

<the actual prompt>
```

This guarantees the argv element's first character is never `-`, so it can
never be mistaken for a flag by `agy`'s own argv parser — regardless of
what the caller-supplied prompt itself starts with (even something like
`--dangerously-skip-permissions --mode danger-full-access`).

### `--print-timeout` derivation

`--print-timeout` is derived from `timeoutMs`, leaving roughly a minute of
margin so `agy`'s own timeout fires *before* this adapter's `SIGKILL` — a
run that legitimately takes long gets a chance to report `agy`'s own clean
timeout (a normal non-zero exit, surfacing as `AntigravityProcessError`
with `agy`'s own stderr attached) instead of always losing the race to a
hard kill that discards whatever it had already written. With the default
15-minute `timeoutMs`, that's `--print-timeout 14m`. Below a 2-minute
total budget there's no meaningful minute-granularity margin to carve out,
so the whole budget is used, in seconds, instead (e.g. `timeoutMs: 30_000`
→ `--print-timeout 30s`).

## Worktree lifecycle

Identical to `@floor-agents/codex-cli`'s, because it's the **same shared
code** — `@floor-agents/core`'s `resolveWorktree` (`packages/core/src/review/worktree.ts`),
extracted there once this package needed byte-for-byte the same lifecycle a
second reviewer package already had. This package's own `src/worktree.ts`
is a thin wrapper binding the `'AntigravityReviewer'` label (used only to
brand error messages and the auto-created worktree's directory name — e.g.
`antigravityreviewer-review-<uuid>`).

- A detached worktree is created at `headSha` from `clonePath` under
  `worktreeRoot` (`git fetch origin <headSha>` then `git worktree add
  --detach`), verified (`git rev-parse HEAD` must equal `headSha`,
  otherwise `WorktreeMismatchError` — re-exported from
  `@floor-agents/core`), and removed afterward — on success, on any thrown
  error, and on timeout.
- A caller-supplied `worktreePath` gets the same verification, is used
  as-is, and is **never removed** by this package on any path — cleanup of
  a caller-supplied path is always the caller's job.
- Never runs directly in `clonePath` itself.

See `@floor-agents/codex-cli/README.md`'s "Invocation, and the pitfalls it
exists to avoid" section for the fuller narrative behind this lifecycle
(worktree-add-can-lie-about-success, timeouts needing `SIGKILL` not
`SIGTERM`, etc.) — it applies here unchanged.

## Header extraction

`agy`'s raw stdout is a progress/tool-use log followed by the actual
review. This package's `extractReview()` finds the line
`## Reviewer agent (Gemini)` (optionally `, round N` for a follow-up round
on the same PR) and returns everything from there to the end, however long
the preceding log is — never a `head`-based cut. If the header is missing,
it throws `MalformedReviewError` (carrying the last 40 lines of raw output)
rather than ever returning unverifiable text.

## Prompt template

`prompts/review.md` is the default adversarial review prompt template —
functionally identical to `@floor-agents/codex-cli`'s, except its header
line is `## Reviewer agent (Gemini)` and its "what you could not verify"
instruction describes the deny-policy constraint (no writes, no shell
commands) rather than a `--sandbox read-only` flag. Render it with
`renderReviewPrompt(template, vars)`, same signature as codex-cli's.

## Options (`AntigravityReviewerConfig`)

| Option | Default | Notes |
|---|---|---|
| `binary` | `'agy'` | Path to the agy binary, or a fixture script in tests. An explicit `null` is rejected the same as any other non-string. |
| `timeoutMs` | 15 minutes | The process is killed (`SIGKILL`) and `AntigravityTimeoutError` thrown past this. |
| `model` | `'gemini-3.1-pro-high'` | Emitted as `--model <value>`, always. Must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, max 128 chars. |
| `effort` | — | One of `'low'`/`'medium'`/`'high'`. Emitted as `--effort <value>` when set; omitted otherwise. |
| `clonePath` | — | Local clone used to create a detached worktree at `headSha` when `review()` is called without a `worktreePath`. Required in that case. |
| `worktreeRoot` | OS temp dir | Directory under which detached worktrees are created. |
| `settingsPath` | `~/.gemini/antigravity-cli/settings.json` | Read before every `review()` call to enforce the deny policy above. Override in tests. |

## Gate wiring

`GATE_REVIEWER=gemini` selects this reviewer as the primary in
`src/gate.ts` (built via `src/gate/create-reviewer.ts`'s
`antigravityReviewerConfigFromEnv`), reading `GATE_AGY_BINARY`/
`GATE_AGY_MODEL`/`GATE_AGY_EFFORT`/`GATE_AGY_TIMEOUT_MS`/
`GATE_AGY_CLONE_PATH`/`GATE_AGY_WORKTREE_ROOT`/`GATE_AGY_SETTINGS_PATH` —
one-to-one with the options table above, all optional, same
empty-string-counts-as-set convention as codex-cli's env mapping. The same
vendor kind (`gemini`) can also be selected as a **second** reviewer via
the gate config's `gate.secondReviewer` key, run in addition to the primary
on auth-labelled PRs — see `docs/review-gate.md`.
