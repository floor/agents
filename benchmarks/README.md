# Benchmark set

Thirteen real, already-solved issues from `floor/mtrl` and `floor/vlist`, packaged so that an
agent run on any of them can be scored automatically. The engine is being redesigned; this set
measures every step before and after (see "What useful means" in `docs/lead-and-decisions.md`):
throughput, speed, reliability, cost and quality, on real work rather than on the engine's own
tests.

Each task is a merged pull request turned back into an issue: the code before the fix, a brief
that describes the wanted behaviour without the solution, and the reference PR's own tests as the
proof.

## The tasks

| id | source | size | kind |
|---|---|---|---|
| `mtrl-slider-range-second-default` | mtrl#135 | XS | fix — a range slider's second value defaults to max |
| `mtrl-theme-error-container-roles` | mtrl#194 | XS | fix — baseline theme defines the error-container roles |
| `vlist-search-filtered-selection` | vlist#230 | XS | fix — selection on a filtered list selects the shown item |
| `vlist-tree-arrowdown-from-click` | vlist#286 | XS | fix — ArrowDown continues from the clicked tree node |
| `mtrl-badge-label-rules` | mtrl#155 | S | fix — one rule for empty labels, overflow, positioning |
| `mtrl-slider-destroy-listeners` | mtrl#192 | S | fix — destroy removes the handles' listeners |
| `mtrl-slider-form-value` | mtrl#103 | S | feature — a named slider takes part in forms |
| `vlist-rebuild-restore-scroll` | vlist#295 | S | fix — rebuild restores scroll without snapshots() |
| `vlist-render-window-ceiling` | vlist#193 | S | fix — the render window has a ceiling, reported once |
| `vlist-search-with-groups` | vlist#234 | S | fix — search highlighting works with groups() |
| `mtrl-slider-second-handle-no-value` | mtrl#130 | M | fix + typing — slider off the noImplicitAny list |
| `mtrl-timepicker-value-sync` | mtrl#187 | M | fix (breaking) — one 24-hour value for API, events, form |
| `vlist-carousel-over-data` | vlist#221 | M | fix — a carousel over data() wraps |

Sizes count changed lines under `src/` in the reference PR: XS under 30, S under 150, M under
500.

## Task format

One YAML file per task in `tasks/<id>.yaml`:

| field | meaning |
|---|---|
| `id` | the file name without `.yaml` |
| `repo` | `owner/name` on GitHub |
| `baseCommit` | the merge commit's first parent: the code before the fix. An agent starts here |
| `referencePr` | the pull request that solved it |
| `referenceHead` | that PR's head commit: the full reference solution |
| `sizeClass`, `changedSourceLines` | size of the reference change under `src/` |
| `brief` | what the agent receives: title, goal, relevant files and APIs, expected behaviour, constraints, out of scope, done-when. It never contains the solution diff |
| `testFiles` | the reference PR's test files that pin the behaviour |
| `checks` | the commands that decide pass or fail, run in order from the repository root |
| `notes` | optional: anything the checks do not cover, or that made the task hard to package |

## Verifying the set

```bash
bun benchmarks/verify.ts                  # every task
bun benchmarks/verify.ts --only <id>      # one task (repeatable)
bun benchmarks/verify.ts --verbose        # also print the checks' output
```

For each task the verifier checks out `repo` at `baseCommit` in a temporary git worktree, then:

- **(a) discrimination** — writes only the `testFiles` from `referenceHead` onto the base and
  runs `checks`. They must fail, and fail on assertions: a test file that cannot load (a missing
  module or export) counts as not discriminating, because it would reward guessing a file name
  rather than the behaviour.
- **(b) solvability** — checks out `referenceHead` and runs the same `checks`. They must pass.

It prints a table and exits non-zero unless every task is both. One clone per repository is
cached under `$BENCH_CACHE` (default `<tmpdir>/floor-agents-benchmarks`) and fetched again only
when a commit is missing. It needs git, bun and network access to GitHub; it does not import
anything from the engine. A full run takes about half a minute on a warm cache.

## Scoring an agent run (not built yet)

1. Start the agent on a clean checkout of `baseCommit` with the task's `brief` as the issue.
2. On the agent's final branch, write the reference `testFiles` over whatever the agent wrote to
   those paths, then run `checks`. Pass or fail is the task's result. The agent's own tests are
   kept for review but do not decide the result.
3. Record, per task and per run: wall time from start to a finished branch (and to an approved
   PR when the review loop runs), cost per vendor, the number of turns and revisions, and every
   harness failure (a stop caused by the engine rather than by the code: crash, timeout, lost
   seat, sandbox refusal).
4. Across the set: pass rate (throughput), median and worst wall time (speed), runs without a
   harness failure (reliability), cost per passed task (cost). Quality is judged later by
   whether the change needed to be redone; the `notes` field lists what the checks leave to
   review (size budgets, browser checks).
