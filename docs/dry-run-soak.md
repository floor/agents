# Dry-Run Soak Runbook

How to run the review-and-gate loop (`docs/review-gate.md`) against a real
repository in **dry run** for several days before trusting it to merge
anything, and how to decide when it's safe to flip merging on.

This document deliberately never names the specific repository this soak
targets, nor any person or issue associated with it — that's the sort of
thing that belongs in the gitignored local config described below, not in
this public repo. Everywhere a concrete value would go, this doc says **the
target repository** instead.

## What "dry run" means here

`mergeEnabled: false` (the config file default, also settable as
`GATE_MERGE_ENABLED=false`) is not a placeholder — it's the actual safety
mechanism. With it set, `runGatePass` still does everything else for real:
polls PRs, computes gate decisions, calls the configured `Reviewer`, and
posts its verdict as a real PR comment. The only thing it skips is the
`GitAdapter.mergePR` call itself — where it would otherwise merge, it logs
`DRY RUN would merge #<n> at <sha>` and stops. See
`packages/orchestrator/src/gate/loop.ts`'s `mergeable` branch.

That means a dry run soak produces the exact same reviews, the exact same
gate decisions, and the exact same log line telling you what it *would*
have done — just with the merge itself withheld. The soak's job is to
compare those "would merge" moments against what a human coordinator
actually decided, for long enough to trust the gate's judgment before
handing it real merge authority.

## Prerequisites

- **A GitHub token** with:
  - read access to the target repository (to list PRs, read diffs, checks, comments)
  - write access to post PR comments (to post the reviewer's verdict)
  - it does **not** need merge/write-to-contents permissions for a dry run —
    `mergeEnabled: false` means `GitAdapter.mergePR` is never called, so a
    token that can only read + comment is enough for the whole soak period.
    Add merge permission only once you're ready to flip `GATE_MERGE_ENABLED`
    on (see below).
- **The codex CLI, authenticated** on the machine that will run the loop —
  `~/.codex/auth.json` must already have a valid session (interactive
  `codex` login once, per `packages/codex-cli/README.md`). The loop shells
  out to it for every `needs_review` decision; an unauthenticated CLI fails
  every review attempt, not just the merge step.
- **A local clone path** for the target repository, used to create detached
  git worktrees per review (`GateConfig`'s reviewer needs a real checkout to
  run `git diff`/read files against). Any plain `git clone` of the target
  repository on the host works; the loop only ever reads from it and creates
  worktrees under a separate directory — it never pushes to or otherwise
  mutates the clone itself.
- **Bun** installed on the host (same runtime the rest of this repo uses).

## Config file shape

Copy `config/gate/gate.example.yaml` to a **local, gitignored** file (the
`.gitignore` pattern `config/gate/local.*` covers this — e.g.
`config/gate/local.dry-run.yaml`) and fill in the target repository's real
values. Every key below already exists in the example file with its own
inline comment; this section explains what each one means for a dry-run
soak specifically.

```yaml
repos:
  - your-repo               # bare name; owner comes from GITHUB_OWNER (env)

pollIntervalMs: 60000       # how often to sweep the target repo's open PRs

promptTemplatePath: config/gate/review-prompt.md
stateDir: ./data/gate       # per-PR decision state — see "Logs" below

mergeEnabled: false         # THE dry-run switch. Leave this false in the
                             # file; GATE_MERGE_ENABLED (env) can override
                             # it, but during a soak just don't set that env
                             # var at all rather than relying on remembering
                             # to keep it "false".

excludeAuthors:
  - your-bot-account         # the identity GITHUB_TOKEN posts comments as —
                              # must be listed here so the loop never treats
                              # its own posted-verdict comment's author as a
                              # PR it should also review/merge (this matters
                              # if the same bot account both opens PRs
                              # elsewhere in the target repo AND runs this
                              # loop — exclude it defensively either way)

gate:
  authLabels:
    - auth                   # label(s) that put a PR on the stronger
                              # two-vendor + runtime-sign-in-check gate —
                              # set this to whatever label the target repo
                              # actually uses for auth/session-sensitive PRs,
                              # or leave it as a label nothing uses yet if
                              # the target repo has no such convention
  needsHumanLabel: needs-human
  trustedReviewers:
    your-bot-account: codex  # REQUIRED, not just for merging: maps the
                              # GitHub login GITHUB_TOKEN posts as to the
                              # vendor name GATE_REVIEWER resolves to (codex,
                              # by default). Without this entry, the loop's
                              # own posted review is never a "trusted"
                              # verdict, decideGate() can never see a valid
                              # approve-as-is, and every PR just sits at
                              # needs_review forever — you would see reviews
                              # get posted but the "would merge" log line
                              # never appear, which defeats the point of a
                              # soak. Double check this is set before
                              # starting, not after wondering why nothing
                              # ever reaches mergeable.

vendor:
  labelPrefix: "vendor:"
  branchPrefixes: []         # fill in only if the target repo's own PRs use
  bodyMarkers: []             # a recognizable branch-prefix or body-marker
                               # convention for their author tooling; both
                               # are optional and empty is a valid target-
                               # repo-specific choice, not a placeholder to
                               # fill blindly
```

`GATE_CONFIG_PATH` (env) must point at this local file — see the process
env shape below.

## Running it as a supervised long-running process

A soak runs for days, so it needs to survive terminal closes, host reboots,
and crashes without you babysitting it. **PM2** is the house convention for
supervising long-running processes on this host — see
`ecosystem.gate.config.cjs` at the repo root.

```js
// ecosystem.gate.config.cjs
module.exports = {
  apps: [
    {
      name: 'floor-agents-gate-dryrun',
      script: 'src/gate.ts',
      interpreter: 'bun',
      // Loads env from .env.gate (gitignored — see below) without ever
      // putting real values in this tracked file. Requires a Bun version
      // with `--env-file` support (bun --version; 1.1+).
      interpreter_args: '--env-file=.env.gate',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',       // see "Why fork, not cluster" below
      autorestart: true,
      // The loop writes its own state to stateDir (default ./data/gate) on
      // every single pass — if PM2 were watching the working directory for
      // changes, it would treat every state-file write as a reason to
      // restart the process, over and over, forever. Always false here.
      watch: false,
      max_restarts: 10,
      min_uptime: '30s',
      out_file: './data/logs/gate-dryrun-out.log',
      error_file: './data/logs/gate-dryrun-error.log',
      time: true,
    },
  ],
}
```

**Why fork, not cluster:** the gate loop is a single stateful poller with no
inbound HTTP traffic to load-balance — there is nothing for a second cluster
worker to do except double-poll the same PRs and duplicate every review and
log line. One fork instance is correct, not a limitation.

`.env.gate` (gitignored) holds the actual secrets/config pointers:

```bash
# .env.gate — never commit this file
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=<target repo's owner>
GATE_CONFIG_PATH=config/gate/local.dry-run.yaml
GATE_REVIEWER=codex
# Deliberately omitted: GATE_MERGE_ENABLED. Leaving it unset means the
# config file's mergeEnabled: false is what actually governs behavior —
# see "What dry run means here" above.
```

**This agent does not create `.env.gate` or `config/gate/local.dry-run.yaml`
with real values, and does not start this process.** Both files are
gitignored and target-specific; the coordinator running the actual soak
fills them in and starts the PM2 process by hand:

```bash
pm2 start ecosystem.gate.config.cjs
pm2 logs floor-agents-gate-dryrun
```

## What the logs look like

Every pass logs exactly one line per PR it looked at
(`packages/orchestrator/src/gate/loop.ts`'s `processPR`):

```
[gate] acme/widgets#42 head=a1b2c3d implementer=cursor decision=needs_review
[gate] acme/widgets#42 head=a1b2c3d implementer=cursor decision=hold reason="checks pending" (changed)
[gate] acme/widgets#42 head=a1b2c3d implementer=cursor decision=mergeable (changed)
DRY RUN would merge #42 at a1b2c3d4e5f6...
```

- `head=` is the PR's head sha, shortened to 7 characters.
- `implementer=` is the attributed vendor (`packages/orchestrator/src/gate/vendor.ts`).
- `decision=` is one of `needs_review` / `hold` / `blocked` / `mergeable`,
  with `reason="..."` attached for every non-`mergeable` decision.
- `(changed)` appears only when this pass's decision differs from the
  previously persisted one for the same head — a PR sitting unchanged at
  `hold` across many passes logs plainly, without `(changed)`, so the log
  doesn't repeat the same line forever.
- A `mergeable` decision with dry run in effect always logs the separate
  `DRY RUN would merge #<n> at <sha>` line right after the decision line —
  that second line is the one to grep for when comparing against real
  merges (see below).
- A reviewer call, and whether its output was posted or rejected as
  malformed, each get their own log line too (`posted <vendor> review for
  head ...` / `returned malformed output ... — not posted`).

## Comparing dry-run decisions against what actually happened

`scripts/gate-audit.ts` reads the loop's persisted state directory
(`stateDir`, one JSON file per PR — see
`packages/orchestrator/src/gate/state-store.ts`) and prints a table:

```bash
bun run scripts/gate-audit.ts ./data/gate
# or: GATE_STATE_DIR=./data/gate bun run scripts/gate-audit.ts
```

```
PR                    HEAD      DECISION      REASON                     UPDATED
acme/widgets#42        a1b2c3d   mergeable     -                          2026-09-01T14:03:11.000Z
acme/widgets#43        f9e8d7c   blocked       checks failing             2026-09-01T14:03:12.000Z
acme/widgets#44        1122334   needs_review  -                          2026-09-01T14:03:12.000Z
```

During a soak, walk this table (or `pm2 logs`'s `DRY RUN would merge`
lines) against the PRs a human coordinator actually merged over the same
period by hand, and note every case where they disagree — either the gate
said `mergeable` and a human held off (or merged something different), or
the gate never reached `mergeable` on something a human happily merged. A
disagreement isn't automatically a bug in the gate (a human might have
merged something the gate was right to hold, or vice versa); it's a
prompt to go look at *why* the two disagreed and decide which one was
actually correct.

## When to flip `GATE_MERGE_ENABLED` on

Only once **all** of the following hold:

1. **At least 5 consecutive calendar days** of the dry-run process running
   continuously against the target repository (not 5 days of wall-clock
   elapsed with the process down for stretches of it — the loop needs to
   actually have been polling and deciding throughout).
2. **Zero disagreements** between a `DRY RUN would merge` decision and what
   a human coordinator would have done with that exact PR at that exact
   head, across that whole window — not "mostly agreed," not "the one
   disagreement was minor." Any disagreement resets the clock: fix whatever
   caused it (a gate rule, a `trustedReviewers`/`vendor` config gap, a
   reviewer prompt issue), then restart the 5-day count from zero.
3. **At least 10 distinct PRs** reached a `mergeable` decision during the
   window. Five quiet days with only one or two PRs touched isn't enough
   signal either way — the gate needs to have actually been exercised.
4. **No auth-labeled PR was silently stuck** the whole window (see
   `docs/known-issues.md`'s "Auth-gated PRs are not auto-reviewed by the
   review-and-gate loop" — that limitation still applies here and isn't
   fixed by this soak; if the target repo uses `authLabels`, confirm those
   PRs got their two independent reviews from elsewhere and the gate held
   them correctly, not that they simply never came up).

When all four hold, set `GATE_MERGE_ENABLED=true` in `.env.gate` and
`pm2 restart floor-agents-gate-dryrun --update-env`. Keep watching the logs
and `scripts/gate-audit.ts` output closely for at least the first day after
the flip — the switch to real merges is the one change in this whole runbook
that isn't reversible after the fact for whatever it merges.
