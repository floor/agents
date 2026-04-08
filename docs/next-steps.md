# Next Steps

Updated April 9, 2026 — after four sprints of dogfooding.

---

## Completed

- ~~Fix provider routing~~ — traced and fixed. The orchestrator correctly routes through `getLLMAdapter(agent.llm.provider)`. The billing issue was `ANTHROPIC_API_KEY` in the Claude Code subprocess env.
- ~~Split the orchestrator~~ (FLO-16) — done. `orchestrator.ts` (131 lines), `pipeline.ts` (356 lines), `review.ts` (162 lines), `llm-runner.ts` (81 lines), `native-runner.ts` (344 lines).
- ~~Native agent execution with git worktree~~ (FLO-15) — implemented. Claude Code edits files in worktrees. Last mile: git push from worktree fails.

## In Progress

### 1. Fix git push from worktree

**Priority:** High — this is the last blocker for the native execution loop.

Claude Code successfully edits files and commits in the worktree (exit 0). But `git push origin <branch>` fails with "failed to push some refs." Needs investigation:
- Check if the worktree has the right remote configured
- Check if git credentials propagate to worktrees
- May need to push from the main repo: `git push origin agent/branch` after the worktree commit

### 2. Auth: Claude Code Max plan via setup-token

**Priority:** High — currently using `ANTHROPIC_API_KEY` (per-token billing).

Run `claude setup-token` to set up long-lived Max plan auth. Then strip `ANTHROPIC_API_KEY` from the native runner env to use subscription billing instead of per-token.

The native runner has a TODO comment marking this.

### 3. Linear rate limiting and polling interval

**Priority:** Medium — hit 5000 req/hr limit during sprint 4.

Current: 5-second polling, no backoff on errors. Fix:
- Increase polling interval to 30 seconds (spec originally said 30s)
- Add exponential backoff on errors (double interval on each failure, cap at 5 min)
- Stop polling entirely when rate limited (parse `Retry-After` or wait 1 hour)
- Log rate limit events instead of spamming error messages

### 4. Context builder as hints for native agents

**Priority:** Low — native mode works without this, it's a quality improvement.

The context builder output is included in the Claude Code prompt as starting hints. This works but could be improved:
- Only include file paths as hints (not full content — Claude Code reads them itself)
- Include import graph from the v2 file selector
- Reduce token waste from duplicate content

### 5. Task decomposition for complex issues

**Priority:** Low — depends on workflow engine (FLO-13).

Complex tasks (workflow engine, branch checkout) timeout or produce incomplete results. The PM agent should assess complexity and decompose large tasks into sub-issues before assigning to dev agents.

---

## Sprint Summary

| Sprint | Model | Tasks | PRs | Merged | Key Outcome |
|:------:|-------|:-----:|:---:|:------:|-------------|
| 1 | Gemma (LM Studio) | 5 | 5 | 2 | Pipeline works, code needs cleanup |
| 2 | Claude Code Sonnet (API) | 5 | 5 | 5 | Production quality, all merged |
| 3 | Claude Code Sonnet (CLI) | 5 | 1 | 1 | Adapter mismatch exposed |
| 4 | Claude Code (native worktree) | 5 | 0 | 0 | Editing works, push fails |

## Architecture Status

```
packages/
├── core/              ✅ Stable
├── anthropic/         ✅ Stable
├── claude-code/       ⚠️ Works but auth needs setup-token
├── lmstudio/          ✅ Stable
├── openai/            ✅ Stable
├── gemini/            ✅ Created by AI agents (sprint 2)
├── github/            ✅ Stable (branch protection, request logging)
├── task/              ✅ Linear + Things + GitHub Issues
├── context-builder/   ✅ v2 import tracing (created by AI agents)
└── orchestrator/      ⚠️ Native mode needs push fix
    ├── orchestrator.ts     131 lines — watch loop, dispatch
    ├── pipeline.ts         356 lines — task execution flow
    ├── native-runner.ts    344 lines — worktree dev + review
    ├── review.ts           162 lines — API-based CTO review
    ├── llm-runner.ts        81 lines — tool use loop
    ├── worktree.ts          82 lines — git worktree utilities
    ├── guardrails.ts        91 lines — output validation
    ├── cost-tracker.ts      70 lines — spending limits
    ├── state-store.ts       55 lines — crash recovery
    ├── output-parser.ts     40 lines — parse tool calls
    └── dispatcher.ts        18 lines — agent resolution

Tests: 116 across 22 files
```
