# Experiment: First AI Team Sprint

**Date:** April 7, 2026
**Duration:** ~1 hour (setup to all PRs merged)
**Objective:** Validate the full Floor Agents pipeline end-to-end with real tools

---

## Team Composition

| Role | Agent | Provider | Model | Cost |
|------|-------|----------|-------|------|
| Developer | Backend Developer | LM Studio (local) | google/gemma-4-e2b | $0.00 |
| Reviewer | CTO / Tech Lead | Claude Code | Opus 4.6 | Per review |

## Infrastructure

- **Task manager:** Linear (Floor IO workspace, "agents" project)
- **Git platform:** GitHub (floor/agents repo)
- **Orchestrator:** Running locally via `bun run src/main.ts`
- **LM Studio:** Local server on localhost:1234

## Issues Processed

5 issues created in Linear, all labeled `agent` + `backend`:

| Issue | Title | Complexity |
|-------|-------|:----------:|
| FLO-5 | Add a slugify utility to @floor-agents/core | Simple |
| FLO-6 | Add retry utility with exponential backoff to @floor-agents/core | Simple |
| FLO-7 | Add request logging to the GitHub adapter | Medium |
| FLO-8 | Add Gemini adapter for Google AI models | Hard |
| FLO-9 | Add GitHub Issues task adapter | Hard |

## Results

All 5 issues were processed. Gemma wrote code for all of them. CTO (Opus) approved all 5.

| PR | Issue | Gemma Time | Files | CTO Verdict | CTO Cost |
|:--:|-------|:----------:|:-----:|:-----------:|:--------:|
| #1 | FLO-9: GitHub Issues adapter | 1m 26s | 3 | Approved | $0.12 |
| #2 | FLO-8: Gemini adapter | 2m 2s | 4 | Approved | $0.09 |
| #3 | FLO-7: Request logging | 1m 40s | 1 | Approved | $0.04 |
| #4 | FLO-6: Retry utility | 1m 45s | 3 | Approved | $0.04 |
| #5 | FLO-5: Slugify utility | 1m 51s | 3 | Approved | $0.03 |

**Totals:**
- Coding cost: **$0.00** (local Gemma)
- Review cost: **$0.32** (Claude Code Opus)
- Total time: ~12 minutes for all 5 issues (sequential)
- PRs created: 5
- PRs approved: 5/5

## Merge Results

| PR | Status | Notes |
|:--:|--------|-------|
| #5 | Merged (squash) | Slugify — clean merge |
| #3 | Merged (squash) | Request logging — clean merge |
| #4 | Closed (conflict) | Retry — barrel file conflict with #5, applied manually with cleanup |
| #2 | Closed (conflict) | Gemini adapter — conflict after merges, to be re-created |
| #1 | Closed (conflict) | GitHub Issues adapter — conflict after merges, to be re-created |

## Code Quality Assessment

### What Gemma did well
- **Structure**: created correct file paths, proper exports, followed the package pattern
- **Logic**: core algorithms were correct (slugify, retry backoff, request logging)
- **Tool use**: reliably called `write_file` and `pr_description` tools across multi-turn conversations
- **Context**: understood the codebase structure from the directory tree and selected files

### What Gemma got wrong
- **Test imports**: used relative paths (`'../src/utils/slugify'`) instead of package imports (`'@floor-agents/core'`)
- **Test framework**: used Jest APIs (`describe`, `it`, `jest.spyOn`) instead of `bun:test` (`test`, `expect`)
- **Syntax errors**: missing commas in object literals (retry options)
- **Barrel file rewrites**: rewrote entire `index.ts` instead of adding a single export line
- **Style**: didn't consistently follow "no semicolons" convention

### CTO Review Quality
- Opus approved everything — including code with the issues above
- The review was based on PR diffs only, not running tests
- The CTO prompt needs to be stricter: require running `bun run typecheck` and `bun test`
- Consider having Claude Code (as CTO) actually check out the branch and run commands

## Bugs Found and Fixed During the Experiment

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Linear GraphQL validation error | Used `String!` where Linear expects `ID!` for filter fields | Changed team/project filters to use `ID!` type |
| Linear mutation error | Used `ID!` where Linear expects `String!` for mutation parameters | Changed mutation `$id` params to `String!` |
| GitHub 403 on branch creation | Fine-grained token lacked write permissions | Created classic token with `repo` scope |
| Team ID format | Passed team key (`FLO`) instead of UUID | Added key-based filter: `team: { key: { eq: $teamId } }` |
| Merge conflicts on PRs #1, #2, #4 | All PRs modified `packages/core/src/index.ts` barrel | Sequential processing without rebasing |

## Lessons Learned

### 1. The pipeline works
The core loop — Linear issue → context building → LLM call → tool use → guardrails → GitHub PR → review — is functional and produces real, usable code.

### 2. Local models are viable for coding
Gemma 4 E2B on LM Studio produced working implementations for all 5 tasks at zero cost. Quality varies — simple tasks are clean, complex tasks need review. The multi-turn tool use loop works reliably.

### 3. The CTO needs teeth
Approving everything defeats the purpose of review. The CTO agent should:
- Run `bun run typecheck` before approving
- Run `bun test` on the branch
- Be stricter about test quality and import conventions
- Claude Code (as CTO) should check out the branch, not just read a diff

### 4. Branch conflicts are a real problem
When processing multiple issues sequentially, PRs that modify the same files (barrel exports) conflict. Solutions:
- Process one issue at a time and merge before the next
- Rebase branches before creating PRs
- Have the orchestrator detect conflicts and rebase automatically

### 5. Prompting matters more than model quality
Gemma's mistakes (wrong test imports, Jest APIs) are prompt failures, not model failures. The system prompt should explicitly include:
- The exact import style (`import { x } from '@floor-agents/core'`)
- The test framework (`bun:test`, not jest)
- Examples of correct test files from the repo

### 6. Linear activity feed is valuable
Even with the GraphQL bugs, the concept of posting detailed progress to Linear issues works well. When fixed, it will give full visibility into what the agents are doing without checking logs.

## Next Steps

1. **Fix CTO review quality** — have Claude Code check out the branch, run typecheck and tests
2. **Improve prompts** — add explicit examples of correct imports, test patterns, conventions
3. **Handle merge conflicts** — rebase or sequential merge strategy
4. **Re-run FLO-8 and FLO-9** — Gemini adapter and GitHub Issues adapter (closed due to conflicts)
5. **Test the Linear activity feed** — verify comments post correctly with the GraphQL fix
6. **Track metrics** — parse success rate, compilable output rate, merge-ready rate per the dogfooding plan
