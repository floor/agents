# The polish sprint

The record of the work that began on 2026-09-18: why product work stopped, what was decided, every
change made to the engine and what it was for, what the measurements say, and what is still open.
It is written to be sufficient on its own. A person or an agent who has read nothing else should be
able to pick the work up from this page.

Companion pages:

- [The Run Path](./run-path.md) is the working map: the twelve steps of a run, how each fails, and
  the four ideas the polish follows.
- [First Self-Hosted Day](./experiments/2026-09-18-first-self-hosted-day.md) is the day that led here.
- [The Benchmarks](./experiments/2026-09-18-benchmarks.md) are the two measured rounds on real tasks.
- [Coordinating a Team](./guides/coordinator.md) holds the working rules of the coordinator role.

## 1. Why

On 2026-09-18 the engine ran three projects from a Linear queue: vlist, mtrl and itself. Grok
implemented through Cursor; a committee reviewed every pull request. In a four-hour window one
product PR was merged in vlist. The two previous days, without the pipeline, had seen 27 and 29.
A 17-line fix took about three hours and seven runs.

Of the day's stops, one was the implementer's code. The others were the harness: budgets,
guardrails sized for another path, an unforced fetch, a discussion cap that erased hints, a gate
that ended the run on five bytes. Each stop cost the whole run, because the only recovery was a
retry from the base.

The owner's decision, in substance: the engine is the ground staff that lets a team grow in a
coordinated way, so it is worth the time it takes. Product work on vlist and mtrl stops, their
target dates are cleared, and the engine is polished first. Repairing a slow pipeline *through*
the slow pipeline was the wrong loop, so during the sprint the engine is written by hand.

## 2. How the sprint is run

These rules are specific to the sprint. The standing rules of the coordinator role are in
[Coordinating a Team](./guides/coordinator.md).

- **Who writes the engine.** The coordinator (Claude) writes engine code directly, pairing with the
  owner. No implementer agent writes the engine during the sprint. The rule "the coordinator does
  not implement" is suspended for this repository only; it stands for vlist and mtrl.
- **Agents are fixtures, not authors.** Real runs with Grok, Codex, Claude or Gemini are the way to
  prove a change end to end. A test with a fake agent is not enough on its own.
- **Direction.** The coordinator decides the order of work from the run-path map and reports it.
  The owner can redirect at any time.
- **Merging.** The coordinator merges its own polish PRs into `staging`, never on green CI alone.
  Every PR first gets an *adversarial pass*: an attempt to break the change on the neighbouring
  cases, not only the case it was written for. What was tried is written on the PR. Small PRs, one
  idea each. The owner can say "hold merges" at any time. Tags, releases, `main` and policy stay
  with the owner.
- **Docs move with the code.** Every engine change updates `docs/` in the same PR. The run-path
  table and its proposal section shrink as they come true.
- **Checks.** `bun run typecheck` and `bun test` before a PR; wait for CI with
  `gh pr checks --watch` and merge only when every check reads `pass`.

## 3. What changed

All merged into `staging` on 2026-09-18, in order. "Found by" says what made the defect visible.

### Before the sprint was declared (same day)

| PR | Change | Found by |
|----|--------|----------|
| #55 | A project declares where its tasks live (`tasks.source`, labels) in its manifest | — |
| #56 | A **stop report** on the issue when a turn ends early, and `run --retry` to archive a failed state and start again | Grok killed at a 10-minute budget with nothing on the issue |
| #57 | The engine gets its own manifest, so it can be run on itself | — |
| #58, #65, #69 | Gemini joins the committee; then through the Antigravity CLI on the subscription; then trusted with private sources | the API key was free tier only |
| #59 | Sandbox tests skip where `sandbox-exec` cannot nest (`sandboxAvailable()`) | the engine could not pass its own gate: exit 71 |
| #60 | The issue's discussion is fed into the implementer's prompt | hints had no way to reach a run |
| #61 | The engine's open items live in Linear | — |
| #62 | Every PR is reviewed by the committee before the coordinator sees it | the owner asked for a committee review on every PR |
| #63 | Guardrails for a package-sized task | a new package tripped the 20-file cap and `bun.lock` |
| #64 | `@floor-agents/antigravity`: Gemini through `agy` as a native provider | — |
| #66 | PR review in `run` mode starts the external voters' bridges instead of polling comments for five minutes | in `run`, external voters fell through to a five-minute comment poll |
| #67 | pm2: one watcher per project, each with its own state directory (prepared, **not started**) | two projects must not share a process |
| #70 | The Claude adapter says why a turn failed (`subtype`), and a capped turn is a failed execution | abstentions with no reason |
| #71 | Grok leaves the review seat while it implements | an implementer reviewing its own work |
| #72 | Native instructions no longer name API-path tools | `agy` was told not to use `write_file`, its only write tool |

### The sprint

| PR | Change | Found by |
|----|--------|----------|
| #74 | **Four warm-ups and the run-path map.** Forced fetch of the branch (FLO-188). Guardrail sizes measure what the change adds, not whole files (FLO-201). The last `VOTE:` marker outside code wins (FLO-186). An oversized comment is shortened, never dropped; the newest is always kept (FLO-184) | three failed retries; a one-line changelog edit refused at 104 KB; a REJECT recorded as APPROVE; three hints that never reached a run |
| #75 | **A run keeps its history.** `attempts[]`, gate runs and `reviews[]` are appended to the state and survive `--retry`. `status --issue` prints them | every number in the day record had been read out of logs by hand |
| #76 | Guardrails count only added lines: a deletion is zero, a rewrite is not counted twice, an unchanged move is zero. Truncated comments keep their code fences balanced | the adversarial pass on #74, after it was merged |
| #77 | **`verify --issue`.** A preserved tree goes through guardrails and gate again and on to the PR, without another agent turn | a finished tree that failed the gate for a reason that was not the code's |
| #78 | **The gate verifies a clean export** of the tree, not the agent's worktree. `setup` runs in the export; a failing setup is reported as `Setup: <name>`; the export is always removed | a probe: a check passed thanks to an ignored file the commit did not contain |
| #79 | **Outputs keep their end.** `excerpt()` and `createExcerptBuffer()` in core; the gate keeps 4 KB of head and 28 KB of tail per stream; adapter and bridge errors carry an excerpt. A gateway `result` may be flagged `failed`; the committee records a failed execution and never parses it for a vote. The PR says "X did not review" with the reason | benchmark 1: Codex out of quota, and the PR showed its banner instead of the reason |
| #80 | A review's own gateway binds a free port and hands it to its bridges; `Gateway.getPort()` | benchmark 2: two runs at once, both on port 3100, and one lost its Codex seat |
| #81 | **`review --issue`.** Seats the committee again on the same PR when the last review ended with no decision. Refuses when there is a verdict | both benchmarks: an unjudged PR could only be judged by redoing the whole run |
| #82 | **Reviewers read the issue discussion.** A decision recorded there by the owner or the coordinator is settled; disagreement with it is a concern for the owner, not a BLOCKER | benchmark 2: three cycles blocked on a decision the owner had already recorded |
| #84 | **A blocker that stood through a revision stops the loop** for a person, named in both wordings; `review --issue` reopens it once the point is settled on the issue. `BLOCKER` headings and bullets are recognised; each member's blockers are kept on the review record | benchmark 2: mtrl #92 spent three cycles on one sentence; on vlist #260 Claude's `## BLOCKER 1:` headings were not read, and the implementer got the first 500 characters of the review instead |
| #85 | **A revision continues the implementer's session**: the CLI resumes its own published turn and is told only the blockers, the discussion and where it stands. Falls back to the full brief within seconds if the session cannot be resumed; `FLOOR_AGENTS_RESUME=off` | benchmark 2: revision turns of 5 to 10 minutes, most of it reading the same 111 KB again. Proven first by experiment: a Cursor session resumed from another folder, inside the sandbox, kept its memory and wrote only in the new folder |
| #86 | **Stopping and starting again** (FLO-182). Every child the engine starts is tracked (agent CLI, checks, bridges); `SIGINT`/`SIGTERM` end their whole process groups, for every command. A turn cut short by a stop is recorded as stopped by the engine: no failure, no report, no `needs-human`, and it resumes at the next start. A start closes a turn that a crash left open, ends its agent if it is still the same process, and tells the issue. pm2 `kill_timeout` raised to 10 s | the precondition for running as a service: pm2 restarts processes routinely |
| #87 | **Machine slots** (FLO-196): two tasks at once per machine, across every engine process; a third waits and says who holds the slots. A slot is a loopback port, so binding is atomic and a crash gives it back. `FLOOR_AGENTS_MAX_RUNS`, `FLOOR_AGENTS_SLOT_PORT` | the limit was a habit of the coordinator. The first version, with lock files, let two real processes in at once in its own test; it was replaced before it was ever merged |

Open: **#73** (Grok's "a gate failure becomes a fix turn"). It reached the maximum review cycles
with Codex's recovery blockers outstanding. Its tests are worth keeping when typed outcomes are
built; the PR itself is not to be merged as it stands.

### Commands that exist now

| Command | What it is for |
|---------|----------------|
| `run --issue <id>` | One issue, from branch to reviewed PR |
| `run --issue <id> --retry` | Archive a failed state and start again from the base; history is carried over. **Force-resets the branch, which closes an open PR** (FLO-187) |
| `verify --issue <id>` | Take a preserved tree through guardrails and gate again, then publish, without another turn |
| `review --issue <id>` | Seat the committee again after a no-decision |
| `status --issue <id>` | Every attempt, gate run and review of an issue |
| `watch` | The long-running service mode; not yet used unattended |

## 4. What the measurements say

Details in [The Benchmarks](./experiments/2026-09-18-benchmarks.md).

| | Morning | Benchmark 1 | Benchmark 2 |
|---|---|---|---|
| Label to gate-verified PR, small task | 2–3 hours, several runs | about 10 min, one attempt | about 8–9 min, one attempt |
| Stops caused by the harness | most of them | none | one (the port), since fixed |
| Committee | — | no decision, Codex out of quota | a real verdict every cycle |
| Label to **approved** PR | — | never | never: both reached the three-cycle maximum |

The first pass is solved for small tasks. The cost has moved to the revision loop: a revision turn
takes five to ten minutes because it starts a fresh session with the full prompt, and each
revision adds code that gives reviewers more to reject. Two seats that disagree can consume all
three cycles without converging.

## 5. Direction set by the owner

Recorded on the evening of 2026-09-18.

- **A service.** The engine should run as a service and be able to trigger an implementer to take
  a task and code it. Agreed. `watch` and the pm2 watchers exist; three defects are what keeps them
  off: a restart starts a second agent on the same issue (FLO-182), runs share a machine with no
  slots (FLO-196), and a retry force-resets the branch and closes the open PR (FLO-187). Trigger in
  two stages: **label first** (a person puts `agent` on an issue), then **pull** (the service takes
  the top ready issue of the active milestone when a slot is free) once the exit test passes.
  Polling is enough locally; webhooks wait until the engine runs on a server.
- **An admin console.** To see the team, the roles and the progress, and to add a member or start
  a task. Agreed, read-only first. The data already exists (attempts, gates, reviews, costs, the
  manifest). "Start a task" and "re-seat a review" are one call each. "Add a team member" changes
  the manifest, which lives in git: the console opens a pull request rather than writing the file.
  It sits on the service process; Linear stays where work is defined.
- **A coordinator vote that counts double**, so that a task which failed for a reason other than
  code quality can still be validated. The coordinator's advice: not the weight, because the
  committee's value is independent eyes and the coordinator is the same model as one seat. Instead,
  authority over *process* failures: re-seat the committee or substitute a spare seat (exists
  since #81), and as a last resort a recorded override, allowed only when the missing votes are
  failed seats, at least one member approved, no member rejected or raised a blocker, and CI is
  green. **Open: the owner's decision.**

## 6. Order of work

1. ~~Warm-ups~~ (#74, #76). ~~The attempt record, `status`, `verify`~~ (#75, #77). ~~A gate that
   verifies what is published~~ (#78). ~~Readable failures~~ (#79). ~~`review`~~ (#81).
2. **Service safety:** ~~FLO-182 (shutdown and restart)~~ (#86), ~~FLO-196 (machine slots)~~ (#87),
   then the pm2 watcher on one project with the label trigger.
3. **The revision loop:** ~~a blocker repeated across two cycles ends the loop as "needs a
   person"~~ (#84); typed outcomes (FLO-198); a revision continues the previous session in the same
   worktree with a small prompt (FLO-192, 197, 199, and `--add-dir` for `agy`, FLO-203).
4. **`--continue`** instead of a force reset (FLO-187), and `floor-agents clean` for kept
   worktrees and any `gate-*` directory left by a killed process.
5. **Review sized to the change:** lanes, per-member budgets, a cycle that closes once its outcome
   cannot change (FLO-181, 193, 194, 195). A third seat, so one missing reviewer never blocks a
   verdict.
6. **Unattended:** polling with backoff (FLO-174), the merge recorded on Linear (FLO-190), agents
   posting under their own identity (FLO-189).
7. **The console**, read-only first.
8. **Exit test:** about ten small real issues, unattended; label to approved PR in 25 minutes or
   less, nine times out of ten. Then product work resumes through the service.

## 7. What is parked

- **vlist:** FLO-191 (a fold re-keys the mounted elements; its finished tree is preserved on disk)
  and FLO-163 (the carousel without the 101 cycles, blocked by it); FLO-166, 168, 91, 88; the phone
  passes (FLO-87); the 3.0.0 release (FLO-89). PR #260 (FLO-167) is open, at maximum cycles, not to
  be merged. PR #248 is an old carousel attempt, not to be merged.
- **mtrl:** 0.9.7 is shippable from `main` on the owner's word; one 0.9.7 PR is open and rejected.
  PR #92 (N10) is open, at maximum cycles. **Open decision:** N10 changes what `check()` does; the
  owner said yes for 0.9.8, and Codex holds that the repository's `AGENTS.md` sends behaviour
  changes to the next major. One of the two has to give.
- **Gemini as implementer:** blocked by FLO-203 (`agy` needs its workspace named). As reviewer it
  works and is off the default seats.
- **Owner's side:** a Telegram group for mtrl; a Linear OAuth app so agents post under their own
  name (FLO-189).

## 8. Where knowledge lives

The same fact should not need to be remembered in two places, and nothing that matters should
live only in an agent's private memory.

| What | Where | Why there |
|------|-------|-----------|
| Work: issues, milestones, decisions on a task | Linear, team FLO, one project per repository | it is the queue the engine reads; a decision written under an issue reaches the implementer and the reviewers |
| How the engine works and how to use it | `docs/` in this repository | it moves with the code, in the same PR |
| The working map and the plan | [run-path.md](./run-path.md) and this page | one place to see what is true and what is next |
| What happened on a given day, with numbers | `docs/experiments/` | a record is evidence; it is not rewritten |
| What each run did | the state directory: one JSON per issue, with attempts, gates and reviews; `status --issue` prints it | the engine writes it as it goes |
| How the team is composed | each repository's `.agents/agents.yaml` | versioned with the project |
| The coordinator's habits and the owner's preferences | the coordinator's private memory: Markdown files outside any repository, one fact per file, with an index loaded at the start of each session | it is how one assistant stays consistent between sessions |

The private memory is a convenience for one assistant, not a source of truth. It is not shared
with other agents, not versioned with the code, and a note in it reflects what was true when it
was written. Anything in it that another person or agent would need is written here or in
[Coordinating a Team](./guides/coordinator.md); the memory then only needs to point at these pages.
