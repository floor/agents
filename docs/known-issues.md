# Known Issues

Updated April 9, 2026.

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
