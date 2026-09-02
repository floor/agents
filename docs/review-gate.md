# Review & Gate Mode

A second orchestrator mode, alongside the task-pipeline mode (`src/main.ts`):
instead of an issue driving an agent to open a PR, this mode watches PRs
that **this process did not create**, drives an independent-vendor review
through a pluggable `Reviewer`, posts the review verbatim, and merges once
a deterministic gate says the PR is ready. It implements the "Review"
section of floor/radiooooo's `AGENTS.md` protocol.

Entry point: `bun run gate` (`src/gate.ts`). Implementation:
`packages/orchestrator/src/gate/`.

## How it works

Every `pollIntervalMs` (default 60s), for each configured repo:

1. List open PRs (`GitAdapter.listOpenPRs`).
2. For each PR, compute a gate decision (`decideGate`, pure, no I/O) from
   its labels, draft flag, check status, comments, and the head commit's
   date.
3. Act on the decision:
   - **`needs_review`** — if the configured `Reviewer`'s vendor hasn't
     already posted a current verdict for this head (and isn't the same
     vendor as the PR's implementer), build a prompt from
     `promptTemplatePath` plus the PR's title/body/base/head/changed-file
     list, call `Reviewer.review()`, and post the returned text **as-is**
     as a PR comment. It is never edited, summarized, or re-wrapped.
   - **`mergeable`** — squash-merge (`GitAdapter.mergePR`) if
     `mergeEnabled` is true; otherwise log `DRY RUN would merge #<n> at
     <sha>` and do nothing. **Dry run is the default.**
   - **`hold`** / **`blocked`** — no action beyond logging. (A `blocked`
     PR needs a human or another reviewer to change something; a `hold`ing
     PR is waiting on CI, on being marked ready for review, or on the
     `needs-human` label being lifted.)
4. Log one line per PR: repo, head sha, implementer vendor, decision kind,
   and reason. Persist the decision to `stateDir` so a restart doesn't
   double-merge or double-review.

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

## Verdict validity ("is this verdict for the *current* head?")

A parsed verdict only counts toward a decision if:

1. Its vendor differs from the PR's implementer vendor (see below) — a
   reviewer cannot review its own PR, even under a fresh instance/context.
2. It is **current for the head**: it either names the head sha (full or
   abbreviated, 7-40 hex chars extracted from anywhere in the comment), or
   it names no sha at all *and* was posted after the head commit's own
   date. This lets a plain "LGTM" style verdict count without insisting
   every reviewer paste a sha, while still treating a verdict as stale
   once a new commit lands after it (a push invalidates it, per the
   protocol's auth-gate rule — applied here to every gate, not just auth).

The **latest** valid verdict per vendor is what counts; an earlier
`changes needed` from a vendor is superseded by that same vendor's later
`approve as-is` (and vice versa).

## Vendor attribution

`packages/orchestrator/src/gate/vendor.ts` determines a PR's implementer
vendor, in order:

1. A `vendor:<name>` label (default prefix `vendor:`) — always wins.
2. A branch-name prefix rule from config (e.g. `cursor/` → `grok`).
3. A PR-body marker rule from config (e.g. a line starting
   `Claude-Session:` → `claude` — the same trailer this repo's own commits
   carry).
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
uses the **same rule as the default gate** — the protocol states
structural PRs merge the same way as any other once reviewed and green,
autonomy being the point.

Check status (`GitAdapter.getCheckStatus`) combines the legacy combined-
status API and the checks API: any failing check wins, all must succeed
for `success`, and **no checks configured at all is `pending`**, never an
implicit pass.

## Known limitation: auth-gated PRs are not auto-reviewed by this loop

The auth gate's "else blocked, naming what's missing" rule applies even
when a PR has **zero** verdicts yet — the decision is `blocked`, not
`needs_review`. Since the loop only invokes its configured `Reviewer` on a
`needs_review` decision, an `auth`-labeled PR never gets its first (or
second) review triggered automatically by this loop; the two required
independent-vendor reviews have to come from elsewhere (a human, another
lane, or another agent running `codex exec` directly per the protocol —
see AGENTS.md's "Invoking a reviewer yourself"). This loop's job for such
PRs is to hold the merge gate correctly, not to solicit the extra
scrutiny auth-sensitive code is meant to get. Tracked in
[Known Issues](./known-issues.md).

## Config

`GATE_CONFIG_PATH` (default `config/gate/gate.example.yaml`) points at a
YAML file — see that file for every key with inline comments:

```yaml
repos: [radiooooo]        # bare names; owner comes from GITHUB_OWNER
pollIntervalMs: 60000
promptTemplatePath: config/gate/review-prompt.md
stateDir: ./data/gate
mergeEnabled: false        # or set GATE_MERGE_ENABLED=true in the environment
gate:
  authLabels: [auth]
  needsHumanLabel: needs-human
vendor:
  labelPrefix: "vendor:"
  branchPrefixes: [{ prefix: cursor/, vendor: grok }]
  bodyMarkers: [{ prefix: "Claude-Session:", vendor: claude }]
```

`GATE_MERGE_ENABLED` (env) overrides the file's `mergeEnabled`. `GATE_REVIEWER`
selects the Reviewer `src/gate.ts` wires: `codex` (default — shells out to
`codex exec --sandbox read-only "<prompt>" < /dev/null`, per the protocol's
documented invocation) or `fake` (no shell-out, for smoke-testing the loop).

## Running it against floor/radiooooo

```bash
cp .env.example .env
# Edit .env: GITHUB_TOKEN, GITHUB_OWNER=floor
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
}
type ReviewResult = { text: string }
type Reviewer = { vendor: string; review(input: ReviewInput): Promise<ReviewResult> }
```

Exported from `@floor-agents/core`, along with `createFakeReviewer(...)` for
tests. A separate `@floor-agents/codex-cli` package is being built against
this exact interface; `src/gate.ts`'s inline `codex exec` glue is meant to
be replaced by it once available, not extended.
