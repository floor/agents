# Coordinating a Team

The engine runs implementers and reviewers. Someone still has to decide what they work on, read
what they produce, and merge it. That role is the **coordinator**. In the Floor projects it is held
by an assistant (Claude) working with the project owner. This page is the role's working rules.
Each one was learned from a measured mistake, and the mistake is given, because a rule without its
reason gets dropped the first time it is inconvenient.

These rules lived in the coordinator's private memory. They are written here so that they do not
depend on it: another coordinator, human or not, should be able to take the role from this page.

## The role

- **The coordinator does not write the fix.** When a run stops short or a PR misses the point, the
  coordinator writes a hint on the issue and reruns. Judgment goes into the brief and the review;
  the code comes from the implementer. *Why:* a fix written by the coordinator hides the hint from
  the record, skips the implementer's PR trail, and makes one party both author and reviewer. The
  coordinator's own commits are manifests, environment wiring, docs and the record. Exception: a
  repository explicitly declared hand-written for a period, as `floor/agents` is during
  [the polish sprint](../polish-sprint.md).
- **One coordinator.** Agents never wait on the owner; the owner does not brief the implementer.
- **What the coordinator decides alone:** the order of work, briefs and hints, merging a reviewed
  green PR into an integration branch (`staging`, `next`), closing the issue afterwards.
- **What always goes to the owner:** tags, releases, deploys, merges into `main`, public posts,
  public-API or behaviour decisions, and any waiver of the committee.

## Before a run

- **A brief that touches a contract is reviewed first.** Navigation rules, index spaces, public
  API: have a reviewer read the *brief* before any code is written. *Why:* a one-minute review of a
  brief found seven gaps; two review cycles that day came from flaws in the coordinator's own
  briefs. Design flaws are cheapest there.
- **Hints are short, signed, and posted before the run.** Point at a preserved worktree or a backup
  branch; never paste a diff. Then check that the hint is in the agent's prompt. *Why:* three hints
  larger than the discussion cap were silently dropped and never reached a run. The cap has since
  been fixed (a long comment is shortened, the newest never dropped), and the habit stays.
- **Decisions go under the issue.** A decision the owner takes about a task is written as a comment
  on that issue. *Why:* it is the only place both the implementer and the reviewers read. On
  mtrl #92 a decision recorded elsewhere cost three review cycles.
- **At most two runs at once on one machine.** *Why:* more stretched implementer turns from 12 to
  18 minutes and tripped a flaky browser assertion. The engine now enforces it (machine slots, see
  the [CLI reference](../cli.md#machine-slots)): a third task waits instead of starting.
- **Wiring is the coordinator's follow-up.** Anything added to `package.json` scripts, such as a
  new browser check in `test:browser`, is not part of an agent's brief.
- **Small fixes take the fast lane.** Trial seats and lanes are routed by label.

## Configuration

- **Never switch branches in a checkout the engine reads.** Make manifest and config PRs from a
  detached worktree elsewhere; after the merge, fast-forward the checkout and re-read the file.
  *Why:* `run` reads `.agents/agents.yaml` from disk at start, not from a commit. A branch switch
  put an old manifest back, and an implementer was killed at a ten-minute budget a second time.
- **Manifests live in each repository's `.agents/`.** Not in a shared parent folder.
- **Before changing a budget, a threshold or a constant, search the tests for it.** *Why:* a
  "chore" that raised two bundle budgets pinned by a test broke the integration branch.
- **Secrets are never read or printed.** `.env` files are loaded by the engine, not opened by the
  coordinator; tokens are passed per command and never pasted.

## Comments and identity

- **Every comment the coordinator posts ends with its signature:**
  `**Agent:** <model> · coordinator`. *Why:* the API key posts under the owner's account, so an
  unsigned comment reads as the owner's words, and the coordinator's comments are the ones that
  carry decisions. The engine signs its own reports as `Floor Agents · engine`; agents sign with
  their name and role. The `coordinator` role is deliberately not filtered out of the discussion,
  so signed hints reach the next run.
- **Act as the project's GitHub account per command**, never by switching the machine's login,
  which races across background jobs.

## Merging

- **A PR from an agent is mergeable only when its latest commit has a committee verdict of
  APPROVED.** If the engine could not run the review, run it first: `review --issue` after a
  no-decision, or the committee scripts by hand on the diff. *Why:* a PR was merged on the
  coordinator's own reading while its last revision had never been reviewed; a post-merge review
  then reproduced two bugs in it. Only the owner can waive the committee, per PR, in words.
- **Config, docs and manifest PRs the coordinator writes** stay outside the committee. Engine code
  the coordinator writes gets an adversarial pass, recorded on the PR, before it is merged.
- **Wait for every check.** `gh pr checks <n> --watch`, then merge only if each check reads exactly
  `pass`. *Why:* a wait loop that ended when *any* check finished merged a PR while the other was
  still running, and it failed.
- **After merging into an integration branch, read that branch's own CI**, not only the PR's.
- **Merge with a merge commit, never a squash**, so each commit's history is kept.
- **Close our own issue after the merge.** `Closes #N` does not fire for a PR into a branch other
  than the default one. For an issue someone else reported, ask the reporter to confirm first.

## Safety

- **Look before deleting or overwriting**, and move things to the trash rather than removing them.
- **Never discard someone's uncommitted changes.**
- **`run --retry` force-resets the branch, which closes an open PR** (FLO-187). Use `verify --issue`
  for a tree that stopped for a reason that was not its code, and `review --issue` for a PR left
  without a verdict. Reach for `--retry` when the work itself has to be redone.
- **No absolute user paths** in code, docs or anything committed.

## Reporting

- Say what was merged, not ask whether to. Report failures with the output, plainly.
- When a run stops, read `status --issue` before the logs: the attempt record names the step that
  failed and the end of what it printed.
- Keep the record where it belongs: work in Linear, how-to in `docs/`, a day's numbers in
  `docs/experiments/`. See "Where knowledge lives" in [the sprint page](../polish-sprint.md).
