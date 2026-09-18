# 2026-09-18 — First self-hosted day

The engine ran three projects for a day — vlist, mtrl and itself — from a Linear queue, with Grok
(through Cursor) implementing and a committee of Claude, Codex, Grok and Gemini reviewing every
pull request. This page is the record; [The Run Path](../run-path.md) is what it led to.

## Setup

- Work queue: Linear, one project per repository, the `agent` label as the trigger.
- Implementer: `cursor-grok-4.6-high`, native, in the implementer sandbox; 40-minute turn budget.
- Review: every PR to the committee (added that day, #62); three cycles at most.
- Gemini joined through the Antigravity CLI (`agy`) on a Google AI Pro subscription (#64).

## What was measured

| | |
|---|---|
| Implementer turn | 8–18 min, median 12 — first turn and revision alike |
| Committee cycle | 5–9 min, the slowest member's time; one bridge timed out at 300 s in three of four reviews |
| Gate (vlist: types, 3,900 tests with coverage, build, size, heap, docs check, four browser suites) | about 2 min |
| Native prompt | 111,064 characters on vlist — the contents of 23 selected files |
| Product PRs merged in vlist in a four-hour window | 1 (the two previous days: 27 and 29 merges) |
| A 17-line fix (`selectNext()` reveals the item), issue to merge | about 3 hours, 7 runs |

## Where the runs stopped

Of the day's stops, one was the implementer's code. The others:

- a 10-minute default budget, twice — once because a branch switch had silently reverted the manifest;
- the engine's own gate could not nest `sandbox-exec` (its suite spawns it) — fixed in #59;
- guardrails sized for the API path: 20 files, a blocked `bun.lock`, a 100 KB per-file cap hit by a
  one-line changelog edit, a total cap that sums whole files;
- bundle budgets set to the byte: a correct core change failed by 5, 5 and 2 bytes, a turn each;
- a flaky browser assertion under load (three runs on one machine);
- a retry's unforced `git fetch` rejected as non-fast-forward, three times;
- coordinator hints larger than the 8,000-character discussion cap: the cap dropped them all;
- `agy` told not to use `write_file` (its only write tool), then working in its own scratch folder
  because no active workspace was named.

Each stop cost the whole run: the only recovery was a retry from the base.

## What the committee was worth

It found what the coordinator missed: two design flaws in a carousel brief (a fold re-created the
whole viewport; an asymmetric fold left a blank peek), a navigation-protocol violation, and — in
a post-merge review — two reproduced bugs in a change the coordinator had merged without a verdict
on its last revision. It also recorded a REJECT as an APPROVE (the parser read a quoted marker).
A one-minute review of a *brief* by Codex found seven gaps before any code was written.

## Decisions taken

- Nothing is mergeable without a committee verdict on its latest commit.
- Grok left the review seat where it implements; Gemini reviews on request; Codex and Claude review
  every PR.
- Product work paused; the engine is polished first, by hand, against the run-path map.
