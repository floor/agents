# @floor-agents/codex-cli

A `Reviewer` implementation that runs the [Codex CLI](https://github.com/openai/codex) in
read-only mode against a pull request's head commit and returns its review text.

## Interface

```ts
export type Reviewer = {
  readonly vendor: string // "codex"
  review(input: ReviewInput): Promise<ReviewResult>
}

export type ReviewInput = {
  readonly repo: string
  readonly prNumber: number
  readonly headSha: string
  readonly worktreePath?: string
  readonly prompt: string
}

export type ReviewResult = {
  readonly text: string
}
```

This shape mirrors the `Reviewer` interface defined in `@floor-agents/core` for the
review-and-gate loop. `core` did not yet export `Reviewer` on `main` when this package
was written, so it is redefined identically in `src/types.ts` (as a `type`, per this
repo's convention) rather than imported, so this PR and core's can merge in either
order. Once core exports `Reviewer`, replace `src/types.ts` with a re-export from
`@floor-agents/core`.

## Usage

```ts
import { createCodexReviewer, renderReviewPrompt } from '@floor-agents/codex-cli'
import { readFile } from 'node:fs/promises'

const reviewer = createCodexReviewer({
  clonePath: '/path/to/a/local/clone/of/the/repo', // used when no worktreePath is given
})

const template = await readFile('packages/codex-cli/prompts/review.md', 'utf-8')
const prompt = renderReviewPrompt(template, {
  repo: 'floor/agents',
  prNumber: 42,
  headSha: 'abc1234',
  title: 'Add codex reviewer',
  body: 'Implements the Reviewer interface for Codex.',
  baseRef: 'main',
  changedFiles: ['packages/codex-cli/src/adapter.ts'],
})

const { text } = await reviewer.review({
  repo: 'floor/agents',
  prNumber: 42,
  headSha: 'abc1234',
  prompt,
})
```

## Options (`CodexReviewerConfig`)

| Option | Default | Notes |
|---|---|---|
| `binary` | `'codex'` | Path to the codex binary, or a fixture script in tests. |
| `timeoutMs` | 15 minutes | The process is killed and `CodexTimeoutError` thrown past this. |
| `model` | — | Emitted as `--model <value>`. Must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` (so it can never start with `-` and be mistaken for a flag) and be at most 128 characters; the constructor throws otherwise. |
| `profile` | — | Emitted as `--profile <value>`. Same validation as `model`. |
| `clonePath` | — | Local clone used to create a detached worktree at `headSha` when `review()` is called without a `worktreePath`. Required in that case. |
| `worktreeRoot` | OS temp dir | Directory under which detached worktrees are created. |

**argv is fixed by design, not by a denylist.** There is no `extraArgs` option and no
way for a caller to add, remove, or reorder an argv element. Earlier drafts of this
package tried to allow arbitrary extra flags while denylisting anything that looked
like a sandbox override, and each review round found a new spelling the denylist
missed (a second `--sandbox`, a short alias, a compact `-s<mode>` form, `-c`/`--config`
keys, `--add-dir`, `--cd`/`-C`...). Rather than keep extending that list, the adapter
now always emits exactly `[binary, 'exec', '--sandbox', 'read-only', ...flags from
model/profile, prompt]` — `model` and `profile` are the only configurable values, each
validated against a strict charset, and each can only ever render as its own
`--model`/`--profile` flag pair. There is no argv position a config value can reach
other than its own flag's value.

## Invocation, and the pitfalls it exists to avoid

The real invocation, learned the hard way running this in the Radiooooo v4 program:

```bash
cd <worktree> && codex exec --sandbox read-only "<prompt>" > out.md 2>/dev/null < /dev/null
```

- **`< /dev/null` (stdin closed) is mandatory.** With stdin open, `codex exec` prints
  "Reading additional input from stdin..." and never returns. This adapter always
  spawns with `stdin: 'ignore'`.
- **Take the output from the header to the end — never `head`.** Codex's raw stdout is
  a progress log followed by the actual review. The review starts at the line
  `## Reviewer agent (Codex)` (optionally `, round N` for a follow-up round on the same
  PR). This package's `extractReview()` finds that header and returns everything from
  there onward, however long the preceding progress log is. If the header is missing,
  it throws `MalformedReviewError` (carrying the last 40 lines of raw output) rather
  than ever returning unverifiable text — callers must never post a review that skipped
  this check.
- **It must run inside a git worktree checked out at the PR head** so `git diff`
  resolves against the right commit. If `review()` is called without a `worktreePath`,
  this package creates one itself: `git -C <clonePath> fetch origin <headSha>` then
  `git worktree add --detach <tmpdir> <headSha>`, then verifies `git -C <tmpdir>
  rev-parse HEAD` actually equals `headSha` (`worktree add` can report success while
  leaving an unexpected checkout in rare interrupted cases — this refuses to silently
  review the wrong commit). It removes the worktree afterwards (`git worktree remove
  --force`, or a direct directory removal if git refuses) — on success, on a thrown
  error, and on timeout, including a failure at any of the three setup steps above
  (setup itself best-effort cleans up before rethrowing). It is never run directly in
  `clonePath` itself. The git invocation itself is injectable (`GitRunner`, exported
  from this package alongside `resolveWorktree`) for testing without a real git
  process.
- **Timeouts escalate straight to `SIGKILL`, not `SIGTERM`.** A `SIGTERM` can be
  ignored by codex or a wedged descendant process, which would leave `proc.exited`
  unresolved and defeat the timeout entirely. `SIGKILL` cannot be caught or ignored.
- **The read-only sandbox cannot run tests**, so its conclusions are analytical only —
  say so explicitly in review prompts (the default template in `prompts/review.md`
  does).
- **It bills a ChatGPT subscription**, not an API key. Auth lives in
  `~/.codex/auth.json`; this adapter does not read, set, or forward any API key env
  var — it inherits the ambient environment as-is.
- **The prompt is passed as a single argv element** via `Bun.spawn`'s array form (no
  shell is invoked), so quotes, backticks, and `$(...)` inside a review prompt are
  inert rather than being interpreted.

## Prompt template

`prompts/review.md` is the default adversarial review prompt template. Render it with
`renderReviewPrompt(template, vars)`, which fills in `{{repo}}`, `{{prNumber}}`,
`{{headSha}}`, `{{title}}`, `{{body}}`, `{{baseRef}}`, `{{changedFiles}}` (a `- file`
list, or a placeholder when empty), and an optional `{{focusBlock}}` (rendered only
when `vars.focus` is given). The template instructs Codex to verify claims against the
code rather than the PR description, name files and risk areas, state what it could
not verify from a read-only sandbox, name the commit it reviewed, and end with exactly
one of:

```
Verdict: approve as-is
Verdict: approve with nits
Verdict: changes needed
```
