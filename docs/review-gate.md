# Review & Gate Mode

A second orchestrator mode, alongside the task-pipeline mode (`src/main.ts`):
instead of an issue driving an agent to open a PR, this mode watches PRs
that **this process did not create**, drives an independent-vendor review
through a pluggable `Reviewer`, posts the review verbatim, and merges once
a deterministic gate says the PR is ready. It implements a common
"independent reviewer + explicit verdict + deterministic merge gate"
pattern for repos that want AI-authored (or human-authored) PRs reviewed
by a different vendor than whoever wrote them before anything merges —
the kind of rule a repo would otherwise state in its own contributor
guide (an `AGENTS.md`/`CONTRIBUTING.md`) and have to enforce by hand.

Entry point: `bun run gate` (`src/gate.ts`). Implementation:
`packages/orchestrator/src/gate/`.

## How it works

Every `pollIntervalMs` (default 60s), for each configured repo:

1. List open PRs (`GitAdapter.listOpenPRs`), skipping any authored by a
   login in `excludeAuthors` — put this process's own posting identity
   there so it never reviews or merges its own PRs.
2. For each remaining PR, compute a gate decision (`decideGate`, pure, no
   I/O) from its labels, draft flag, check status, and comments.
3. Act on the decision:
   - **`needs_review`** — if the configured `Reviewer`'s vendor hasn't
     already been asked to review this exact head (and isn't the same
     vendor as the PR's implementer), build a prompt from
     `promptTemplatePath` plus the PR's title/body/base/head/changed-file
     list and any checklist(s) selected by `checklists.rules` (see
     "Checklists" below), **durably mark the attempt** (`reviewedHeads`, saved to
     `stateDir` immediately — before the call below, not after), then call
     `Reviewer.review()` and post the returned text **as-is** as a PR
     comment — unless it's malformed (no valid header/verdict line), in
     which case nothing is posted, but the mark already made means it
     isn't retried every pass either way. It's never edited, summarized,
     or re-wrapped. "Already asked" is checked against that persisted
     mark, not by re-scanning live comments — a comment later deleted, a
     malformed response, a crash mid-call, or a `trustedReviewers` mapping
     that changes afterward can't cause the same head to be re-reviewed
     forever.
   - **`mergeable`** — squash-merge (`GitAdapter.mergePR`) if
     `mergeEnabled` is true, then immediately persist `merged: true` (not
     at the end of the pass); otherwise log `DRY RUN would merge #<n> at
     <sha>` and do nothing. **Dry run is the default.**
   - **`hold`** / **`blocked`** — no action beyond logging. (A `blocked`
     PR needs a human or another reviewer to change something; a `hold`ing
     PR is waiting on CI, on being marked ready for review, or on the
     `needs-human` label being lifted.)
4. Log one line per PR: repo, head sha, implementer vendor, decision kind,
   and reason. Persist the decision (and `reviewedHeads`/`merged`) to
   `stateDir` so a restart doesn't double-merge or double-review. (A
   narrow, self-healing crash window between `mergePR()` succeeding and
   that save completing is documented in `docs/known-issues.md`.)

On a 403/429 from GitHub, the outer poll loop backs off the delay before
its next pass — compounding across consecutive rate-limit failures (2x,
4x, 8x, ... up to a 30-minute cap) and resetting on the next successful
pass. The GitHub adapter itself retries a 429 a bounded number of times
first (honoring `Retry-After`); only once those retries are exhausted
does the error reach the loop's own backoff.

## The verdict contract

A PR comment counts as a review verdict only if it satisfies the protocol
exactly (`packages/orchestrator/src/gate/verdict.ts`):

- Its **first non-blank line** is a header naming the reviewer's vendor:
  ```
  ## Reviewer agent (Codex)
  ```
  optionally with a round number: `## Reviewer agent (Codex, round 2)`.
  This matches the protocol's "post ... as a PR comment starting with
  `## Reviewer agent (Codex)`" — a header buried later in the comment
  does not count.
- It contains at least one line that is **exactly** one of:
  ```
  Verdict: approve as-is
  Verdict: approve with nits
  Verdict: changes needed
  ```
  If more than one such line appears (e.g. a comment quoting an earlier
  round's verdict inside a code block before giving a fresh one), the
  **last** matching line wins.

A comment missing either the header or a verdict line is not a verdict —
it's ignored by the gate, not treated as an error.

## Trust: a verdict's vendor comes from its author, never its own text

**The header line's vendor name is not an identity — it's formatting.**
Anyone who can comment on a PR (including the PR's own author) can write
`## Reviewer agent (Codex)` followed by `Verdict: approve as-is`. If the
gate trusted that text, it would be trivially spoofable.

Instead, `GateConfig.trustedReviewers` maps GitHub comment-author logins
(case-insensitive) to the vendor(s) they're trusted for. A verdict comment
only counts if:

1. **Its author is a key in `trustedReviewers`** — the vendor used for
   every gating rule below is the *mapped* vendor, not whatever the
   comment's own header claims (see "Multi-vendor logins" below for the
   one case where the header text does matter). An untrusted author's
   comment is not a valid verdict, no matter how well-formed it looks.
2. That mapped vendor differs from the PR's implementer vendor (see
   below) — a reviewer cannot review its own PR, even under a fresh
   instance/context.

`trustedReviewers` defaults to `{}` — fail-closed: nothing is trusted
until you configure it. That must include the gate loop's **own** posting
identity (the account `GITHUB_TOKEN` posts as), mapped to the configured
`Reviewer`'s vendor — otherwise `decideGate` can never see its own posted
review as a valid, trusted verdict, and the PR sits at `needs_review`
forever. (This doesn't cause repeat reviews, since the loop's own
`reviewedHeads` dedup — see "How it works" above — is independent of
`trustedReviewers`; it just means the review gets posted once and then
never counts toward merging.) See `config/gate/gate.example.yaml`.

### Multi-vendor logins (a single posting identity, more than one vendor)

A `trustedReviewers` value can be a plain string (one login, one vendor,
as above) **or an array of vendor names**. The array form exists for one
specific situation: this process posts every review comment under the
same GitHub login (`GITHUB_TOKEN`'s own identity), so a login can't be
mapped to two vendors via two separate string entries — the second entry
would just overwrite the first in the config map. If you configure a
`secondReviewer` (below) and it posts under the same account as your
primary reviewer, that one login legitimately needs to be trusted for
*both* vendors:

```yaml
trustedReviewers:
  your-bot-account:
    - codex
    - gemini
```

For an array value, the actual vendor for a given comment is taken from
the comment's **own header text** (`## Reviewer agent (Codex)` vs.
`## Reviewer agent (Gemini)`) — but **only when that header names one of
the vendors listed for that login**. A header naming anything else is
rejected outright: it does not count as a verdict from any vendor, not
the first array entry, not a default, nothing. This is the rule that
keeps the array form from being a weaker version of the string form — an
attacker (or a misbehaving reviewer) who can get *a* comment posted from
a multi-vendor-trusted login still cannot claim to be a vendor that login
isn't listed for. A single-string value never reads the header at all —
it stays exactly as strict as before this existed.

### Second reviewer (`gate.secondReviewer`)

`GateConfig.secondReviewer` names a vendor (e.g. `gemini`) for a *second*
`Reviewer` the gate loop also runs — in addition to the primary
`GATE_REVIEWER` — on any PR carrying an `authLabels` label. It exists
because of a real gap: the auth gate (below) requires two independent-vendor
`approve as-is` verdicts before it will even consider a PR mergeable, but
`decideGate` itself never returns `needs_review` for an auth-labelled PR —
see "Known limitation" below. Without a `secondReviewer` configured, an
auth-labelled PR's second (and even first) review has to come from
somewhere else — a human, another lane, or another agent invoking a
`Reviewer` directly. With one configured, `packages/orchestrator/src/gate/loop.ts`
triggers both the primary and the second reviewer itself, whenever a PR is
auth-labelled and doesn't already have a blocking verdict (`changes
needed` / `approve with nits`) from a trusted vendor for its current head.

This is loop *scheduling*, not a gating rule — it never changes what
`decideGate` itself decides (see "Keep the decision function unchanged" in
this file's history; the rule table below is exactly what it was before
`secondReviewer` existed). `src/gate.ts` builds the second reviewer with
`createReviewerForKind` (`src/gate/create-reviewer.ts`), using the same
vendor kinds and the same `GATE_CODEX_*`/`GATE_AGY_*` env vars as the
primary — there's no separate env-var namespace for "the second one."

## Verdict validity ("is this verdict for the *current* head?")

A verdict from a trusted author only counts toward a decision if it
**names the head sha** — full or abbreviated (12-40 hex chars extracted
from anywhere in the comment, excluding a token that's part of a URL or
file-path segment, e.g. a permalink's `/commit/<sha>/...`), matched as a
prefix of the actual head sha. Below 12 characters a token isn't
extracted at all — a 7-char prefix is too short to rule out an unrelated
commit sharing it, and a short token embedded in incidental URLs (build
links, CI status links) is common enough that treating it as a deliberate
"I reviewed this commit" statement would be unsafe. **Naming the head sha
is mandatory: there is no fallback for a verdict that names no sha at
all.** The shipped review prompt template (`config/gate/review-prompt.md`)
tells the reviewer to write out the full sha explicitly.

This is deliberate, not an oversight: an earlier version of this rule let
a sha-less verdict count if it was merely posted after the head commit's
own date, on the theory that a plain "LGTM" without a sha still obviously
meant the current head. That fallback was a real hole — a verdict posted
before a force-push to an *older* commit could still read as "posted
after that (older) head's own date" and incorrectly carry an approval
over to a commit the reviewer never saw. A sha-less verdict now simply
never counts, for any gate; the PR just sits at `needs_review` until a
reviewer names the commit it reviewed.

The **latest** valid verdict per vendor is what counts (by comment
timestamp, with the comment id breaking a same-second tie — GitHub ids
are monotonically increasing); an earlier `changes needed` from a vendor
is superseded by that same vendor's later `approve as-is` (and vice
versa).

## Vendor attribution

`packages/orchestrator/src/gate/vendor.ts` determines a PR's **implementer**
vendor — a separate, lower-stakes concern from the *reviewer* trust above:
getting this wrong misattributes blame or lets a same-vendor review slip
through, but (unlike `trustedReviewers`) it never lets an untrusted party
forge an approval, since it never grants merge rights by itself. In order:

1. A `vendor:<name>` label (default prefix `vendor:`) — always wins.
2. A branch-name prefix rule from config (e.g. `cursor/` → `cursor`).
3. A PR-body marker rule from config (e.g. a line starting
   `Generated-By:` → some agent's name — useful for a tool that stamps
   its own PRs with a trailer).
4. Otherwise: `human`.

All three rule sets are config-driven (`config/gate/gate.example.yaml`'s
`vendor:` block) — the defaults above are a starting point, not hardcoded.

## The gate decision table

`packages/orchestrator/src/gate/decision.ts`, pure and exhaustively unit
tested. In order:

| Condition | Decision |
|---|---|
| PR has the `needs-human` label (config `gate.needsHumanLabel`) | `hold` |
| PR is a draft | `hold` |
| Latest valid verdict from any vendor is `changes needed` or `approve with nits` | `blocked` |
| **Default gate** (no `authLabels` label) | |
| — no valid `approve as-is` verdict yet | `needs_review` |
| — has one, checks pending | `hold` |
| — has one, checks failing | `blocked` |
| — has one, checks green | `mergeable` |
| **Auth gate** (PR has a label from `gate.authLabels`, default `auth`) | |
| — fewer than two `approve as-is` verdicts from two distinct vendors, or the PR body has no `runtime sign-in check` section (case-insensitive) | `blocked`, naming what's missing |
| — both satisfied, checks pending | `hold` |
| — both satisfied, checks failing | `blocked` |
| — both satisfied, checks green | `mergeable` |

A `structural`-labeled PR (new dependency, architecture change,
security-sensitive code, spec deviation) that isn't also `auth`-labeled
uses the **same rule as the default gate** — a structural PR merges the
same way as any other once reviewed and green; only auth-sensitive code
gets the stronger gate.

Check status (`GitAdapter.getCheckStatus`) combines the legacy combined-
status API and the checks API: any failing check wins, all must succeed
for `success`, and **no checks configured at all is `pending`**, never an
implicit pass.

## Known limitation: auth-gated PRs are not auto-reviewed by this loop (unless `secondReviewer` is configured)

The auth gate's "else blocked, naming what's missing" rule applies even
when a PR has **zero** verdicts yet — the decision is `blocked`, not
`needs_review`. `decideGate` itself is unchanged: it still never returns
`needs_review` for an auth-labelled PR. What changed is that the loop
(`packages/orchestrator/src/gate/loop.ts`) no longer relies solely on that
decision to know when to call a reviewer — it separately checks, for any
auth-labelled PR, whether a trusted vendor has already posted a blocking
verdict for the current head, and if not, calls both the primary reviewer
and (if `gate.secondReviewer` is configured — see above) the second one,
regardless of the `blocked` decision.

This closes the gap **only when `secondReviewer` is configured**. With it
unset (the default), the behavior is exactly as it always was: an
`auth`-labeled PR never gets even its first review triggered automatically,
and the required independent-vendor reviews have to come from elsewhere (a
human, another lane, or another agent running a reviewer directly against
the PR). This loop's job for such a PR is still just to hold the merge
gate correctly, not to solicit review. Tracked in
[Known Issues](./known-issues.md).

## Checklists

`{{checklists}}` is a placeholder in the review prompt (like
`{{changedFiles}}`) that gets filled with the text of whichever checklist
file(s) match the PR being reviewed, so a reviewer gets a targeted list of
"answer this against the code" questions for the kind of change it is,
not just the generic instructions every PR gets. Configured under
`checklists.rules` in the gate YAML (`packages/orchestrator/src/gate/checklists.ts`):

```yaml
checklists:
  rules:
    - label: auth              # matches a PR carrying this label
      file: docs/review/concurrency.md
    - pathContains: player/       # matches a PR that touched a file whose path contains this text
      file: docs/review/concurrency.md
    - label: parity
      file: docs/review/matrix.md
```

Each rule matches on `label` OR `pathContains` (a rule can set one or both;
either condition is enough). A PR can match more than one rule; every
matched file's content is concatenated into the prompt, in rule order,
deduplicated by file path. With no rules configured (the default), every
prompt renders a "no checklist matched" line in that slot — existing
configs and templates need no changes to keep working.

**The `file` path is resolved in the TARGET repo being reviewed — not in
this repo — AT THE BASE BRANCH'S CURRENT TIP, never at the PR's own
head.** `selectChecklistFiles` only picks file paths from config;
`loop.ts` then calls `GitAdapter.compare(repo, pr.baseRef, pr.headSha)`
fresh, right before loading checklists, to resolve the base branch's
CURRENT head sha (not `PRDetails.baseSha`, which is frozen at PR
creation/last-sync and can lag — see that field's own doc comment), and
passes that as `ref` to `GitAdapter.getFile(repo, file, ref)`. This is
deliberate, not an oversight: loading from the PR's own head would let a
PR edit the very checklist that's about to review it — weaken an item,
or repoint a `pathContains` rule at a file the PR controls — and get a
softer review of itself as a result. Loading from the base means the
checklist a reviewer sees is the one the PR is actually being held to,
whatever the base branch says it is, not something the PR can choose for
itself. If that fresh `compare()` call resolves to `null` — the ref it
was asked to compare no longer exists (e.g. the base branch was deleted,
or the PR closed between listing and review), which the adapter reports
as a 404 — checklist content falls back to the PR's own recorded
`PRDetails.baseSha` instead: still a ref outside the PR's control, just
possibly staler; only if THAT is also empty are checklists skipped
entirely for the pass, never substituted with the head sha, with a line
logged saying so.

A genuine `compare()` API failure is a different case: the adapter
rethrows rather than returning `null`, so it is NOT this fallback path —
it propagates and aborts the whole pass, exactly like any other
unhandled `GitAdapter` call failure in this loop (`getPRDiff`,
`listComments`, ...), not per-PR degradation. What happens next depends
on the error (`startGateLoop` in `gate/loop.ts`): a 403/429 triggers the
loop's rate-limit backoff (the next pass is delayed, compounding on
consecutive rate-limit failures); anything else (a 5xx, a network error)
is logged as `pass failed` and the next pass still runs at the normal
`pollIntervalMs` — no backoff, no skip.

A checklist file genuinely missing at whichever ref resolved (typo, not
yet merged to the base) is skipped the same way, per file, also logged.

Each loaded file is capped at `MAX_CHECKLIST_BYTES` (16 KB) and the whole
concatenated result at `MAX_TOTAL_CHECKLIST_BYTES` (48 KB); either cap
being hit truncates rather than fails, leaving a visible `[... truncated
... ]` marker line in the prompt so a shortened checklist is obvious
rather than silently incomplete.

Checklists are also how a lane self-checks before opening a PR: the
target repo's own `docs/review/README.md` (or equivalent) documents the
same selection table and asks the PR body to say which checklist was
self-checked and why any item didn't apply — see e.g. your-org/your-repo's
`docs/review/README.md`.

## Prepare steps

A Reviewer that creates its own local worktree (today: `@floor-agents/codex-cli`
only) can only run its own commands (`bun test`, `bun run typecheck`, a
linter, ...) against whatever is already on disk in that worktree. Fresh
from `git worktree add`, that's just the checked-out source — no
`node_modules`, no installed dependencies — so those commands routinely
fail before they even get to test anything, and the reviewer is left
reading code rather than exercising it. `gate.prepare` (see
`config/gate/gate.example.yaml` for the exact shape) exists to close that
gap: a per-path-prefix shell command (e.g. a package install) that runs
in the worktree BEFORE the review starts.

Selection mirrors checklists: `packages/orchestrator/src/gate/prepare.ts`'s
`selectPrepareCommands` picks which configured `pathPrefix -> command`
rules match the PR's changed files (a plain "starts with" check, same
style as checklists' `pathContains`, just anchored), in `gate/loop.ts`,
using the same `changedFiles` list checklists already use. This is
SELECTION ONLY — `gate/loop.ts` never runs anything itself. The resolved
list is handed to the Reviewer via `ReviewInput.prepareSteps` (plus
`ReviewInput.prepareTimeoutMs`, from `gate.prepare.timeoutMs`); actually
running each command is the Reviewer's own job, since it's the one that
owns the worktree.

`@floor-agents/codex-cli`'s adapter is the reference implementation
(`packages/codex-cli/src/adapter.ts`):

- Each selected command runs from `<worktree>/<pathPrefix>`, via a plain
  writable shell spawn — deliberately OUTSIDE codex's own
  `--sandbox read-only` invocation, which runs after and is completely
  unaffected (the read-only sandbox stays read-only for the review
  itself; only the prepare step gets write access, and only to do the
  install).
- A command is killed (SIGKILL) and treated as failed if it doesn't
  finish within `prepareTimeoutMs`.
- Failure is best-effort throughout: a failing or timed-out command NEVER
  aborts the review. It's reported to the reviewer as ONE line prepended
  to its prompt ("Note: the prepare step failed or timed out for
  `<command>` in `<pathPrefix>` — dependency-based commands (tests,
  typecheck) may not work in this sandbox.") — silent on success, so a
  normal run's prompt is unchanged from before this feature existed.
- The command's own stdout/stderr (e.g. a full `bun install` log) is
  never captured into anything — not the prompt, not a log a prompt could
  later include — structurally: the spawn discards it outright rather
  than capturing-then-discarding.
- Runs are cached by the target directory's lockfile content hash
  (`bun.lock`, `bun.lockb`, `package-lock.json`, `yarn.lock`, or
  `pnpm-lock.yaml` — whichever is found first), for the lifetime of the
  `Reviewer` instance (the whole gate process, in practice) — an
  unchanged lockfile hashes the same across many reviews, so "run once
  per base sha and reuse" happens naturally without tracking base shas
  explicitly. A directory with none of those lockfiles is never cached —
  nothing to key staleness off of — so it re-runs every review.

A Reviewer that doesn't create a local worktree, or doesn't need this,
ignores `prepareSteps`/`prepareTimeoutMs` entirely — both are optional
`ReviewInput` fields, same as `mergeBaseSha`.

## Config

`GATE_CONFIG_PATH` (default `config/gate/gate.example.yaml`) points at a
YAML file — see that file for every key with inline comments:

```yaml
repos: [your-repo]        # bare names; owner comes from GITHUB_OWNER
pollIntervalMs: 60000
promptTemplatePath: config/gate/review-prompt.md
stateDir: ./data/gate
mergeEnabled: false        # or set GATE_MERGE_ENABLED=true in the environment
excludeAuthors: [your-bot-account]   # this process's own posting identity
gate:
  authLabels: [auth]
  needsHumanLabel: needs-human
  trustedReviewers:        # SECURITY: required — see "Trust" above
    your-bot-account: codex
  # secondReviewer: gemini # optional — see "Second reviewer" above
vendor:
  labelPrefix: "vendor:"
  branchPrefixes: [{ prefix: cursor/, vendor: cursor }]
  bodyMarkers: [{ prefix: "Generated-By:", vendor: some-agent }]
checklists:                # optional — see "Checklists" above
  rules:
    - label: auth
      file: docs/review/concurrency.md
prepare:                    # optional — see "Prepare steps" above
  timeoutMs: 120000
  rules:
    - pathPrefix: web/
      command: bun install --frozen-lockfile
```

`GATE_MERGE_ENABLED` (env) overrides the file's `mergeEnabled`. `GATE_REVIEWER`
selects the PRIMARY Reviewer `src/gate.ts` wires: `codex` (default — the
`@floor-agents/codex-cli` package's `createCodexReviewer`, built directly
against the `Reviewer` interface below; see `packages/codex-cli/README.md`
for its exact invocation contract), `gemini` (the
`@floor-agents/antigravity-cli` package's `createAntigravityReviewer`,
running Google's Antigravity CLI (`agy`); see
`packages/antigravity-cli/README.md` for its invocation contract, including
the read-only deny-policy it requires since `agy` has no sandbox flag of
its own), or `fake` (no shell-out, for smoke-testing the loop). The
optional `gate.secondReviewer` config key (see "Second reviewer" above)
selects a SECOND Reviewer from the same three kinds, independently of
`GATE_REVIEWER` — it is not itself an env var.

The `codex` reviewer's own options
(`binary`/`timeoutMs`/`model`/`profile`/`clonePath`/`worktreeRoot`) are set
via `GATE_CODEX_BINARY`/`GATE_CODEX_TIMEOUT_MS`/`GATE_CODEX_MODEL`/
`GATE_CODEX_PROFILE`/`GATE_CODEX_CLONE_PATH`/`GATE_CODEX_WORKTREE_ROOT`, all
optional — an unset one keeps the package's own default. `GATE_CODEX_CLONE_PATH`
in particular has to be set for `codex` review to actually run: the gate
loop always calls `reviewer.review()` without a `worktreePath`, so the
package needs `clonePath` to create its own detached worktree per review.
`GATE_CODEX_TIMEOUT_MS`, if set, must be a plain positive decimal integer
(milliseconds) — `"900000"`, not `"15m"`/`"1e5"`/`"900000.0"` — anything
else is rejected with a clear error before the reviewer is ever constructed.
An env var that is explicitly set to an empty string counts as set (not the
same as unset) and is passed straight through to the package's own
validation, which rejects an empty `binary`/`model`/`profile`/`clonePath`/
`worktreeRoot` the same as any other malformed value.

The `gemini` reviewer's options (`binary`/`timeoutMs`/`model`/`effort`/
`clonePath`/`worktreeRoot`/`settingsPath`) are set the same way, via
`GATE_AGY_BINARY`/`GATE_AGY_TIMEOUT_MS`/`GATE_AGY_MODEL`/`GATE_AGY_EFFORT`/
`GATE_AGY_CLONE_PATH`/`GATE_AGY_WORKTREE_ROOT`/`GATE_AGY_SETTINGS_PATH`, with
the same validation and empty-string-counts-as-set conventions.
`GATE_AGY_CLONE_PATH` likewise has to be set for `gemini` review to
actually run, for the same reason. Whichever "slot" (primary or second)
the `gemini` vendor is built for, it reads these same env vars — there is
no separate namespace per slot.

## Running it against your own repo

```bash
cp .env.example .env
# Edit .env: GITHUB_TOKEN, GITHUB_OWNER=<your org>, GATE_CODEX_CLONE_PATH
# (a local clone of the target repo — required for GATE_REVIEWER=codex,
# the default, since the gate loop always reviews via an auto-created
# worktree), and point GATE_CONFIG_PATH at a copy of
# config/gate/gate.example.yaml with your own repos/labels/vendor rules
# filled in.
bun run gate
```

Dry run is the default — it will log `DRY RUN would merge #<n> at <sha>`
for anything mergeable rather than actually merging. Set
`GATE_MERGE_ENABLED=true` once you've watched it decide correctly for a
while.

## The `Reviewer` interface

```ts
type ReviewInput = {
  repo: string
  prNumber: string
  headSha: string
  worktreePath?: string
  prompt: string
  mergeBaseSha?: string             // see "PRDetails.baseSha" doc comment / floor/radiooooo #130 round 22
  prepareSteps?: readonly PrepareStep[]  // see "Prepare steps" above
  prepareTimeoutMs?: number
}
type PrepareStep = { pathPrefix: string; command: string }
type ReviewResult = { text: string }
type Reviewer = { vendor: string; review(input: ReviewInput): Promise<ReviewResult> }
```

Exported from `@floor-agents/core`, along with `createFakeReviewer(...)` for
tests. `@floor-agents/codex-cli`'s `createCodexReviewer` implements this
interface directly and is what `src/gate.ts` constructs for `GATE_REVIEWER=codex`
(the default) — see `packages/codex-cli/README.md` for the worktree lifecycle,
the fixed (non-extensible) argv, and the `"## Reviewer agent (Codex)"` header
extraction it does before ever returning a `ReviewResult`.

`@floor-agents/antigravity-cli`'s `createAntigravityReviewer` implements the
same interface for `GATE_REVIEWER=gemini` (or `gate.secondReviewer: gemini`),
running Google's Antigravity CLI (`agy`) instead — see
`packages/antigravity-cli/README.md` for its own worktree lifecycle (shared
with codex-cli via `@floor-agents/core`'s `resolveWorktree`), fixed argv, the
`"## Reviewer agent (Gemini)"` header extraction, and — since `agy` has no
read-only sandbox flag of its own — the settings-file deny-policy it
requires before it will spawn `agy` at all.

**On "verbatim":** the loop posts `Reviewer.review()`'s returned `text`
exactly as returned — no editing, summarizing, or re-wrapping happens in
`loop.ts`. A `Reviewer` implementation is responsible for what it returns;
`@floor-agents/codex-cli`'s adapter returns Codex's raw output from the
`"## Reviewer agent (Codex)"` header onward with trailing whitespace
stripped (see `packages/codex-cli/src/extract.ts`'s `extractReview`) — that
is the only shaping applied anywhere on the path from the Codex subprocess
to the posted PR comment.
