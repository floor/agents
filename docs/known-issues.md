# Known Issues

Updated September 2, 2026.

---

## Open

### Git push from worktree fails
**Severity:** High — blocks native execution loop
**Found:** Sprint 4

Claude Code edits files and commits in the worktree (exit 0), but `git push origin <branch>` fails with "failed to push some refs." The worktree may not inherit git credentials or remote config properly.

**Workaround:** None yet. API-based execution (sprint 2 config) still works.

### Claude Code auth uses API key (per-token billing)
**Severity:** Medium — costs money unnecessarily
**Found:** Sprint 3

The native runner passes `ANTHROPIC_API_KEY` to the Claude Code subprocess because stripping it causes "Not logged in" errors. This means Claude Code bills per-token via the API instead of using the Max plan subscription.

**Fix:** Run `claude setup-token` to configure long-lived Max plan auth, then strip `ANTHROPIC_API_KEY` from the subprocess env.

### Linear rate limit (5000 req/hr)
**Severity:** Medium — blocks operation after heavy use
**Found:** Sprint 4

The 5-second polling interval burns through Linear's rate limit during multiple sprint retries. No backoff on errors — the poll loop retries immediately and floods the log.

**Fix:** Increase polling to 30s, add exponential backoff, respect rate limit headers.

### Auth-gated PRs are not auto-reviewed by the review-and-gate loop
**Severity:** Medium — the auth gate holds correctly, but doesn't help get itself satisfied
**Found:** Review & gate mode build-out (see docs/review-gate.md)

`decideGate()`'s auth-gate rule ("two distinct-vendor `approve as-is`
verdicts plus a runtime-sign-in-check section, else blocked naming what's
missing") returns `blocked`, not `needs_review`, even when a PR has zero
verdicts — literally, per the protocol's "else blocked" wording. The gate
loop (`packages/orchestrator/src/gate/loop.ts`) only calls its configured
`Reviewer` on a `needs_review` decision, so an `auth`-labeled PR never gets
either of its two required reviews triggered by this loop. In practice the
two reviews have to come from elsewhere (a human, another lane, or another
agent invoking `codex exec` directly per AGENTS.md's "Invoking a reviewer
yourself"). The loop still gates the merge correctly either way — it just
doesn't proactively solicit the extra scrutiny auth-sensitive code is
supposed to get.

**Fix (not done here):** either give the loop a second trigger condition
independent of `decideGate()`'s output (e.g. "my vendor hasn't reviewed
this head yet, regardless of decision kind"), or extend `GateDecision`
with a distinct signal for "needs review, but under the auth gate" so the
loop can tell the two cases apart without special-casing `authLabels`
itself.

### `native-runner.ts`'s `cleanEnv` is dead code
**Severity:** Low — cosmetic, not a behavior bug
**Found:** Review & gate mode build-out, reviewing the diff/verdict split this mode intentionally does NOT reuse

`spawnClaudeCode` (native-runner.ts:47) destructures
`const { ANTHROPIC_API_KEY, ...cleanEnv } = process.env` but never passes
`cleanEnv` to the spawned `claude` process — the existing "Claude Code auth
uses API key" issue above is the same root cause (stripping the key
currently breaks auth), so this variable is simply unused today. Worth
removing or wiring up once that issue's fix (`claude setup-token`) lands;
left alone here since it's out of scope for the review-and-gate mode.

---

## Resolved

### Provider routing fixed
The orchestrator correctly routes all LLM calls through `getLLMAdapter(agent.llm.provider)`. The billing issue was `ANTHROPIC_API_KEY` in the Claude Code subprocess env, not a routing bug.

### Orchestrator split (FLO-16)
Split into 11 modules. `orchestrator.ts` is now 131 lines (was 700+).

### Context builder v2
Import tracing implemented by the AI agents in sprint 3 (FLO-11). Merged.

### Guardrail: package.json blocking
Changed from `**/package.json` (blocks all) to `package.json` (root only). Agents can create packages.

### Branch protection
GitHub adapter refuses to write to main/master/develop/production.

### Branch-first workflow
Branch created before LLM call, includes issue ID in name.

### CI=true blocks Claude Code editing
Removed `CI=true` from native runner env. Added explicit `--allowedTools`.

### Stale branches from filter-branch
Old branches had no common history with main after `git filter-branch`. Deleted all agent branches.

### Object.entries on null ProjectConfig
Native runner was passing partial ProjectConfig. Fixed to pass full `company.project`.
