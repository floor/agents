# Next Steps

Priorities from the April 8 review session, after three sprints of dogfooding.

---

## 1. Fix provider routing — respect the configuration

**Priority:** High (actively causing unintended API billing)
**Linear:** FLO-15 (part of)

The orchestrator's review path calls the Anthropic API directly instead of routing through the configured provider. If an agent is configured with `provider: claude-code`, all calls for that agent — including CTO reviews — must go through Claude Code CLI, not the Anthropic API.

**Root cause:** The CTO review step likely bypasses the `llmAdapters` map somewhere, or the Claude Code adapter falls back to the API on certain code paths.

**Fix:** Trace the review execution path and ensure it uses `getLLMAdapter(agent.llm.provider)` consistently. No fallbacks, no shortcuts.

## 2. Native agent execution with git worktree

**Priority:** High (FLO-15)
**Linear:** FLO-15

Replace the clone-based approach with `git worktree`:

```
git worktree add /tmp/agent-FLO-42 agent/FLO-42-branch-name
```

This creates a lightweight checkout that shares the `.git` directory — no cloning, no disk waste, works with large repos.

**Sequential approach (Phase 1):**
1. Agent picks up task, creates branch
2. `git worktree add` to a temp directory for the branch
3. Spawn `claude -p "task..." --cwd /tmp/agent-FLO-42`
4. Claude Code reads/edits files in the worktree natively
5. Commit, push, create PR
6. `git worktree remove` to clean up

**Parallel approach (future):**
Multiple worktrees can coexist — each agent gets its own. But sequential is correct for Phase 1.

**Key insight:** Don't clone the repo. Don't even checkout on the main working directory. Worktrees are the right primitive.

## 3. Split the orchestrator into smaller modules

**Priority:** Medium
**Linear:** Create issue

`orchestrator.ts` is 500+ lines handling: watch loop, dispatch, dev agent execution, CTO review, revision loop, state management, cost tracking, Linear comments. Break into:

- `pipeline.ts` — step-by-step task execution
- `review.ts` — CTO review logic (fetch diff, call reviewer, post verdict)
- `revision.ts` — feedback loop (re-run dev, commit, re-review)
- `orchestrator.ts` — watch loop, dispatch, resume. Thin coordinator.

Each module is independently testable. The orchestrator becomes a thin shell that delegates to the pipeline.

## 4. Context builder as hints, not sole source

**Priority:** Medium

The context builder should NOT be skipped for Claude Code agents. Code is context. But its role changes:

- **For API agents (LM Studio, Gemini):** The context builder IS the only source of context. It selects files and builds the system prompt.
- **For Claude Code agents:** The context builder provides **hints** — "these files are relevant to the task." Claude Code can then explore further on its own.

In practice: include the context builder output in the Claude Code prompt as a "suggested starting point" section, but don't restrict Claude Code to only those files.

## 5. Task decomposition for complex issues

**Priority:** Low (depends on workflow engine)

Complex tasks (workflow engine, branch checkout redesign) fail because they're too large for a single agent session. The PM agent should:

1. Read the issue
2. Assess complexity (file count, scope across packages)
3. If complex → decompose into sub-issues in Linear
4. Each sub-issue is small enough for a single agent session

This requires the workflow engine (FLO-13) to be working first. Park this until then.

---

## Execution order

1. **Fix provider routing** — small, high impact, stops billing leak
2. **Git worktree execution** — enables CTO to run typecheck/tests, fixes the core architecture
3. **Split orchestrator** — makes #2 easier to implement and test
4. **Context builder hints** — integrates naturally once worktree execution works
5. **Task decomposition** — future, after workflow engine
