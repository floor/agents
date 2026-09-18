# The run path

What happens between `floor-agents run --issue FLO-185` and a pull request a person can merge —
step by step, with what each step writes down, how it can fail, and what failing costs today.
Written on 2026-09-18 from the code at `d823bb9` and from one day of real runs (the measurements
are that day's). It is a working map for polishing the engine, not reference documentation:
section 3 is a proposal, and the page should shrink as it comes true.

## 1. The path

`src/main.ts` parses the command, loads the manifest and the project `.env`, builds the adapters
and calls `executeTask` (`packages/orchestrator/src/pipeline.ts`). From there a run is a walk
through `ExecutionState.step`, saved as one JSON file per issue in `STATE_DIR`.

| # | Step | Where | Writes | Fails when | Today that means |
|---|------|-------|--------|------------|------------------|
| 0 | **Admission.** Read the issue; refuse if a state file exists (unless `--retry` archives a failed one). | `main.ts` | — | the issue has a state that is not `failed` | the run refuses; a person edits files in `STATE_DIR` |
| 1 | **Branch.** `createBranch` from the base; on 422 the existing branch is **force-moved to the base**. Issue → In Progress, pickup comment. | `pipeline.ts`, `github/adapter.ts` | `branchName`, step `building_context` | — (it never fails: it destroys) | an open PR on that branch loses its commits and GitHub closes it by itself (vlist #249) — FLO-187 |
| 2 | **Discussion.** Issue comments rendered into the prompt, progress comments dropped, capped at 8,000 characters — by dropping comments until it fits. | `discussion.ts` | — | one comment is larger than the cap | ~~the whole discussion became empty, silently; three hints never reached a run~~ — **fixed (FLO-184):** a long comment is shortened, the newest is never dropped, 16,000 characters |
| 3 | **Worktree.** `git fetch origin <branch>` (not forced), detached worktree under `.agents/worktrees/`, then every `setup` command. | `worktree.ts`, `verified-commit.ts` | `workspacePath`, `baseSha` | the local clone has seen the branch before a retry reset it (non-fast-forward) | ~~`git fetch failed`, run over before it began, three times in a day~~ — **fixed (FLO-188):** the fetch is forced. Setup itself costs a `bun install` (and on mtrl a Chromium install) per turn — FLO-199 |
| 4 | **Prompt.** Role prompt + the *contents* of every selected file + task + discussion + review feedback + instructions. | `native-runner.ts`, `context-builder` | — | never; it is just large | 111 KB on vlist: the agent reads 23 files it did not ask for, then opens them again — FLO-197 |
| 5 | **The turn.** The CLI (`cursor-agent`, `claude`, `agy`) in an OS sandbox: it may write the worktree and its own tool state, nothing else. One budget of time, one of turns. | `native-runner.ts`, `sandbox` | `llmResponse`, cost | the budget runs out; the CLI errors; or **it succeeds somewhere else** | a stop report and a preserved worktree (good, since #56). `agy` without `--add-dir` works in its scratch folder, which the sandbox leaves writable: three "successful" turns wrote nothing we could see — FLO-203. Turns take 8–18 minutes |
| 6 | **Guardrails.** The cumulative diff against the base: file count, blocked paths, per-file size, total size — sizes of the **whole files touched**, not of the change. | `verification.ts` `validateWorktree`, `guardrails.ts` | — | 21 files; a one-line edit to a 104 KB changelog; a new workspace package touching `bun.lock` | the run ends — but the sizes now measure the change (**FLO-201, fixed**): a one-line changelog edit is a few dozen bytes; file count and blocked paths still stop a run and still need a person |
| 7 | **Gate.** Every `verification` command in the worktree, sandboxed, stopping at the first failure; then the tree is snapshotted again to prove the checks changed nothing. Output kept: the **first** 32 KB of each stream. | `verification.ts` | `verification` (all checks, outputs) | a check fails — for a real reason, a flake, five bytes of bundle budget, or a wrong expectation in the agent's own new test | the run ends; the only way forward is `--retry`, which goes back to step 1 and throws the work away. The failing tail of a long test run is not even in the record — FLO-198, FLO-171, FLO-91 |
| 8 | **Commit and push.** `commit-tree` of the verified tree on the branch tip (agent commits are flattened), refused if the tree moved since the gate; push. | `worktree.ts`, `verified-commit.ts` | `commitSha`, `verification.commitSha` | the push is rejected | the run ends (rare) |
| 9 | **Pull request.** Body from the issue, the agent's report and the gate's results; `assertVerified` re-checks that the remote tip is the verified commit. | `pipeline.ts`, `pr-body.ts` | `prUrl`, `prId`, step `reviewing` | — | — |
| 10 | **Review.** Every member with `vote` reviews the diff in parallel; one comment each, one summary; approve needs a majority and no blocker. | `committee-pr-review.ts`, `committee-pipeline.ts` | `reviewVerdict`, `reviewCycle` | a member is slow, silent, empty, or its bridge is missing; the vote parser reads the first `VOTE:` it finds | the cycle lasts as long as its slowest member (5–9 min); fewer than two answers → no decision; ~~a REJECT was recorded as APPROVE~~ (**fixed, FLO-186:** the last marker outside code wins) — FLO-181, FLO-193 |
| 11 | **Revision.** On `request_changes`: back to step 3 — new worktree, new setup, the full 111 KB prompt again plus the blockers, a fresh CLI session — up to three cycles, then `failed: needs human`. | `pipeline.ts` | — | the third cycle still has blockers | the PR stays open with the last rejected commit; the last revision may never be reviewed (vlist #250). A 17-line revision costs 8–14 minutes — FLO-192, FLO-187 |
| 12 | **Done.** Issue → In Review, a summary comment, state `done`. Merging is a person's act, outside the engine. | `pipeline.ts` | step `done` | — | nothing records the merge; the issue is closed by hand — FLO-190 |

Any exception anywhere lands in one `catch`: state `failed`, a report on the issue, the label
`needs-human`. The worktree survives only if the exception came from inside the turn (steps 3–8).

## 2. What the map shows

**One recovery for every failure.** Twelve steps, one way back: `--retry`, which means *start
over from the base*. A turn that ran out of time, a gate that failed by five bytes and a push
that was rejected all cost the same: the whole run. Of the day's stops, one was the
implementer's code; the rest were steps 3, 6 and 7 — and each paid a full turn.

**The work is not a first-class thing.** A finished tree exists only as an unnamed preserved
worktree. Nothing in the state says "this tree passed everything except the size budget"; nothing
can take that tree forward. So the coordinator pasted diffs into hints (and lost them to step 2),
pointed agents at sibling directories, and once published a tree by hand.

**Steps do not know what kind of failure they had.** `verifyAndCommit` throws a string. The
pipeline cannot tell a guardrail from a flake from a rejected push, so it cannot choose between
"ask the agent", "run it again", "ask a person" and "give up".

**Limits written for another path.** The guardrails' sizes and the instructions' tool names came
from the API path, where an agent *outputs* whole files. On the native path they measure the
wrong thing (step 6) and, for `agy`, forbade its only write tool (fixed in #72).

**The state is a cursor, not a history.** One mutable record per issue, overwritten as the run
advances; `--retry` archives it whole. There is no list of attempts, of turns and their
durations, of gate runs. Every number in this page was read out of logs by hand.

**Review is a loop around the wrong unit.** A revision re-enters at step 3 as if it were a new
task. The reviewers' unit is the PR; the implementer's should be *its own previous turn*.

**Process-level gaps.** Runs share a machine with no notion of slots (browser suites flaked
under load — FLO-196); a shutdown leaves the agent running and a restart starts a second one
(FLO-182); Linear is polled every five seconds with no backoff (FLO-174).

## 3. A shape that would hold

Not twenty patches on the table above — four ideas, each removing a family of them.

1. **An attempt is a record, and its tree has a name.** Each implementer turn produces an
   *attempt*: worktree path, tree SHA, the turn's duration and session id, then every gate run on
   it. The state becomes `{ issue, attempts[], review cycles[] }`, append-only. Everything that
   today needs a person and a preserved directory (`verify`, `--continue`, "apply attempt 4")
   becomes an operation on an attempt. *Removes: FLO-171, FLO-187, the hand-published trees, the
   numbers read from logs; makes FLO-190 (the record) a by-product.*

2. **Typed outcomes, and a policy per outcome.** Every step returns one of a small set —
   `ok`, `agent-fixable` (a failing check, with its tail), `retryable` (a flaky step, a fetch),
   `needs-person` (guardrail, budget policy, no decision), `fatal` — and the pipeline decides
   from the type: a fix turn on the same attempt, a re-run of the step, a stop with a precise
   report. *Removes: FLO-198, FLO-188, the flake half of FLO-91, FLO-201's blast radius;
   the single `catch` becomes the exception, not the rule.*

3. **A turn continues; only a task starts.** First turn: fresh worktree (dependencies cloned,
   not installed), a small prompt (paths, not contents), the CLI's session id kept. Fix turns
   and revisions: same worktree, resumed session, a prompt made of what changed — the failing
   tail or the blockers. The active workspace is always named to the CLI. *Removes: FLO-192,
   FLO-197, FLO-199, FLO-203; this is where the 12-minute turns become 4.*

4. **Review sized to the change, decided as soon as it is decided.** A lane per issue (one
   reviewer and one revision for a small fix; the committee for a design); a cycle closes once
   its outcome cannot change; per-member budgets from the manifest; the last vote marker wins;
   an empty or failed answer is a failed execution, said so on the PR; nothing is mergeable
   without a verdict on its latest commit. *Removes: FLO-181, FLO-186, FLO-193, FLO-194, and the
   vlist #250 situation by construction.*

Around them, unchanged in kind: guardrails that measure the diff (FLO-201), oversized comments
truncated rather than dropped (FLO-184), machine slots (FLO-196), a clean shutdown (FLO-182),
polling with backoff (FLO-174), agents posting under their own names (FLO-189).

## 4. An order of work

1. ~~**Warm-ups, independent of the shape:** FLO-188 (forced fetch), FLO-201 (diff-based
   guardrails), FLO-186 (last vote marker), FLO-184 (truncate, never erase).~~ Done, 2026-09-18.
2. **The attempt record** (idea 1) — the state type, the store, `--retry` on top of it, and the
   two commands it makes trivial: `verify` and `--continue`.
3. **Typed outcomes** (idea 2) — starting with `verifyAndCommit`, because the gate is where the
   day was lost; the fix turn falls out of it. Grok's #73 has useful tests to keep.
4. **Continuing turns** (idea 3) — prompt, warm worktree, session resume, `--add-dir`.
5. **Review** (idea 4).
6. **Unattended:** slots, shutdown, polling, the record on Linear, then the pm2 watchers and the
   exit test — ten small real issues, label to approved PR in 25 minutes, nine times out of ten.
