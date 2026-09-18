# 2026-09-18 — Three benchmarks on real tasks

After a day of polish (see [The Polish Sprint](../polish-sprint.md)), the engine was measured on
two real issues, three times, with engine fixes between the rounds. The morning's baseline for a task of this size was two to three
hours and several runs. The target is 25 minutes from label to approved pull request.

## Setup

| | vlist | mtrl |
|---|---|---|
| Issue | FLO-167 — groups: internal `any` on the item passed to `getGroupForIndex` | FLO-96 (N10) — `check()` on an indeterminate checkbox leaves it indeterminate |
| Implementer | `grok-fast` (`cursor-grok-4.6-high-fast`), routed by label | `grok-dev` (`cursor-grok-4.6-high`) |
| Gate | types, about 3,900 tests with coverage, build, size, heap, docs check, four browser suites | tests, strict ratchet, build, tooling, size, consumer check, component checks |
| Review | committee of two: Claude and Codex. Grok and Gemini were off the seats | same |

Both runs were started at the same moment on one machine, which is the agreed maximum. The numbers
come from `floor-agents status --issue`, not from logs.

## Benchmark 1 — Codex out of quota

Engine: the clean-export gate branch, before it was merged.

| | Turn | Gate | Review | Total | Votes | Outcome |
|---|---|---|---|---|---|---|
| vlist FLO-167, PR #259 | 5m00 | 2m30 | 1m56 | about 10 min | Claude approve, Codex abstain | no decision |
| mtrl FLO-96, PR #91 | 4m57 | 1m50 | 2m44 | about 10 min | Claude reject, Codex abstain | no decision |

- One attempt each. No restart, no guardrail stop, no budget stop.
- The committee needs two answers. Codex's account had hit its usage limit, so its seat abstained
  and neither PR got a verdict.
- The reason was invisible. The bridge kept the first 500 characters of the error: Codex's banner
  and the start of the prompt. The line that mattered, "You've hit your usage limit", was cut off.
  The seat was recorded as a member who answered and abstained.
- Claude's reviews were substantive. On vlist it ran the typecheck and the groups tests on an
  export of the PR. On mtrl it reproduced two defects: an `aria-checked` attribute that is not
  valid on a native checkbox and goes stale on `form.reset()`, and `toggle()` left out of the fix.
- The `grok-fast` comparison is inconclusive: the same turn time, on different tasks.

**Led to:** #79 (outputs keep their end; a failed seat is typed and named) and #81 (`review
--issue`).

## Benchmark 2 — Codex back

Engine: `staging` with #78 and #79. The same two issues, run again from the base. The rerun
force-reset both branches, which closed PRs #259 and #91 (FLO-187, a known cost, paid knowingly).

### vlist FLO-167, PR #260

| Attempt | Turn | Gate | | Review | Votes |
|---|---|---|---|---|---|
| 1 implement | 4m35 | 2m30 | cycle 1 | 2m33 | Claude approve, Codex **reject** |
| 2 revision | 10m42 | 2m30 | cycle 2 | 2m49 | Claude reject, Codex reject |
| 3 revision | 7m59 | 2m31 | cycle 3 | 3m32 | Claude reject, Codex approve |

First pass to PR: about 8 minutes. Total: about 38 minutes. Ended at the three-cycle maximum,
not approved.

- Codex found a real hole that Claude had approved: `createVListFromConfig` still accepted a groups
  callback typed for the wrong item, because the factory constrains its argument with
  `VListConfig<any>`.
- Each revision added code and gave the reviewers more to reject. Cycle 2: an inline callback still
  received `any`, and the changelog did not record the type-level breaks. Cycle 3: the adapter call
  path now returned `VList<any>`, and a `NoInfer` that did nothing leaked into public types.
- In cycle 3 the two seats swapped sides. With two seats, a split is always a rejection.

### mtrl FLO-96, PR #92

| Attempt | Turn | Gate | | Review | Votes |
|---|---|---|---|---|---|
| 1 implement | 6m14 | 2m05 | cycle 1 | 1m44 | Claude reject, Codex **failed** → no decision |
| | | | cycle 1 again, by `review --issue` | 1m55 | Claude reject, Codex reject |
| 2 revision | 1m30 | 1m50 | cycle 2 | 1m25 | Claude approve, Codex reject |
| 3 revision | 5m44 | 1m50 | cycle 3 | 2m23 | Claude approve, Codex reject |

First pass to PR: about 9 minutes. Total: about 30 minutes of engine time. Ended at the maximum,
not approved.

- **A new engine defect.** Both runs started their review gateway on the configured port 3100. The
  second lost its Codex seat. Because of #79 the PR said so in plain words: "Codex did not review:
  Bridge failed to start: Failed to start server. Is port 3100 in use?" Fixed in #80.
- **`review --issue` proved itself live.** Built during the benchmark, it seated the committee
  again on the same PR, got Codex's verdict, and the pipeline went on to the revisions. The
  no-decision cycle did not consume one of the three revision cycles.
- **Three cycles on a settled question.** Codex rejected every cycle with the same blocker: the
  change alters what `check()`, `uncheck()`, `toggle()` and `setValue()` do within 0.9.x, and the
  repository's `AGENTS.md` sends behaviour changes to the next major. The owner had already decided
  the point under the issue. The reviewers could not know: the review prompt carried the issue body
  and the diff, never the discussion. The implementer could not resolve it either. Fixed in #82.
  The policy question itself remains the owner's.

## Benchmark 3 — after the loop fixes

Engine: `staging` with #80 to #85 (free review port, `review --issue`, reviewers read the
discussion, a standing blocker stops the loop, a revision continues its session). The same two
issues again, from the base.

### mtrl FLO-96, PR #93 — approved in one cycle

| Attempt | Turn | Gate | Review | Votes |
|---|---|---|---|---|
| 1 implement | 3m42 | 1m50 | 1m34 | Claude approve, Codex **approve** |

About 7 minutes from start to an approved pull request. Codex: "The diff correctly implements the
recorded decision. No blockers found." It kept its point about consumers that set indeterminate
before the value, under the heading "Concern for the owner", and wrote: "The release decision is
settled and is not an implementer blocker." That is #82 working as designed. The change itself was
also better: `toggle()` included, no `aria-checked`. One caveat: the summaries of the earlier
rounds are comments on the issue, and the implementer reads the discussion, so this first pass had
the earlier reviews in front of it. A fair share of the gain is the discussion doing its job.

### vlist FLO-167, PR #261 — not approved; the loop named why

| Attempt | Turn | Gate | | Review | Votes |
|---|---|---|---|---|---|
| 1 implement | 9m29 | 2m30 | cycle 1 | 3m16 | Claude reject, Codex approve |
| 2 revision, continues 1 | 4m30 | 2m30 | cycle 2 | 3m32 | Claude reject, Codex reject |
| 3 revision, continues 2 | 10m41 | 2m30 | cycle 3 | 3m13 | Claude approve, Codex reject |

About 42 minutes. Cycle 3 ended with a standing blocker, detected live: Codex — "Preserve inference
from `items` when the grouping callback accepts a broader item type" — had written the same point
before the revision. The two seats swapped sides again. Continuing the session shows no clear
gain yet: the first revision took 4m30 against 10m42 in round 2, the second 10m41 against 7m59.
Two samples on a hard type-level task say nothing either way.

This task is not small. Three rounds, nine review cycles, and each revision of a generic signature
opened a new hole. It needs a design decision from a person — what `createVListFromConfig` should
infer — more than another turn.

## The three rounds side by side

Minutes. "Morning" is the day record of 2026-09-18, before the polish.

| Step | Morning | Round 1 | Round 2 | Round 3 |
|---|---|---|---|---|
| Implementer, first turn | 8–18, median 12 | 5.0 · 4.9 | 4.6 · 6.2 | 9.5 · 3.7 |
| Implementer, revision turn | 8–14 | — | 10.7 · 8.0 · 1.5 · 5.7 | 4.5 · 10.7 (continued) |
| Gate, vlist | about 8 at midday, then 2 | 2.5 | 2.5 | 2.5 |
| Gate, mtrl | — | 1.8 | 2.1 · 1.8 | 1.8 |
| Review cycle | 5–9 | 1.9 · 2.7 | 1.4–3.5 | 1.6–3.5 |
| Label to verified PR | 120–180, several runs | about 10 | 8–9 | 7 · 14 |
| Label to approved PR | about 180 for a 17-line fix | never | never | **7** (mtrl) · never (vlist) |
| Stops caused by the engine | most runs | 0 of 2 | 1 of 2 | 0 of 2 |

Six first passes, six verified pull requests, no restart. The sample is two issues run three
times: enough to see orders of magnitude, not enough for percentages to the unit.

## What the two rounds show

1. **The first pass is solved for small tasks.** Label to a gate-verified PR in eight to ten
   minutes, in one attempt, where the morning took hours. None of the day's harness stops recurred.
2. **The revision loop is now the cost.** A revision turn takes five to ten minutes because it
   starts a fresh session with the whole prompt. A turn that continues the previous session is the
   fix ([run path](../run-path.md), idea 3).
3. **A loop that cannot converge should stop early.** A blocker repeated unchanged across two
   cycles is not the implementer's to fix. It should end the loop as "needs a person" (idea 2).
   Done the same evening (#84), tested against the blockers quoted above.
4. **Two seats are too few.** One missing reviewer means no decision; one disagreement means a
   rejection, whichever way round. Three seats, with a spare, is the working minimum.
5. **Independent reviewers earn their place.** Codex rejected changes Claude approved and was right
   on the substance. The same happened in the other direction in cycle 3 on vlist.
6. **Readable failures pay for themselves at once.** The port defect was found, understood and
   fixed within the hour because the PR said what had happened.
7. **Running real tasks finds what tests do not.** Benchmark 2 alone produced #80, #81 and #82.

## State left behind

- After round 3: mtrl PR #93 is open and **approved by the committee**; merging it is the owner's
  call, because N10 is a behaviour decision. vlist PR #261 is open, stopped on a standing blocker,
  not to be merged as it stands. Each rerun closed the previous round's pull requests (#259, #91,
  then #260, #92): `run` force-resets the branch (FLO-187).
- Each round's state files were archived by hand as `<issue-id>.bench-<n>.json`.
- No engine process, bridge or gateway is left running.
