# Experiment: Second Sprint — Claude Code Sonnet + Opus

**Date:** April 7, 2026
**Objective:** Re-run all 5 issues with Claude Code (Sonnet for dev, Opus for CTO) using the Max 20x plan

---

## Team Composition

| Role | Agent | Provider | Model | Cost |
|------|-------|----------|-------|------|
| Developer | Backend Developer | Claude Code | Sonnet | Max plan |
| Reviewer | CTO / Tech Lead | Claude Code | Opus 4.6 | Max plan |

All costs covered by the Claude Max 20x subscription — no per-token API billing.

## Results

| PR | Issue | Dev Time | Files | CTO Verdict | Total Cost |
|:--:|-------|:--------:|:-----:|:-----------:|:----------:|
| #6 | GitHub Issues adapter | 3m 29s | 4 | Approved | $0.61 |
| #7 | Request logging | 1m 19s | 1 | Approved | $0.12 |
| #8 | Retry utility | 30s | 3 | Approved | $0.06 |
| #9 | Slugify utility | 26s | 2 | Approved | $0.05 |
| #10 | Gemini adapter | 3m 14s | 6 | Approved | $0.39 |

**Totals:**
- All 5 PRs created and approved
- All 5 merged to main
- Total reported cost: $1.23 (covered by Max plan)
- Total time: ~9 minutes sequential

## Comparison: Gemma (Sprint 1) vs Claude Code Sonnet (Sprint 2)

| Metric | Gemma (LM Studio) | Claude Code Sonnet |
|--------|:------------------:|:------------------:|
| Total cost | $0.32 ($0 coding) | $1.23 (all Max plan) |
| Code quality | Functional, needs cleanup | Production-ready |
| Test imports | Wrong (relative paths) | Correct (package imports) |
| Test framework | Wrong (Jest APIs) | Correct (bun:test) |
| Syntax errors | Yes (missing commas) | None |
| Merge conflicts | 3 PRs conflicted | All merged cleanly |
| Documentation | None produced | None produced* |

*Documentation requirement was added to agent prompts after this sprint.

## Issues Found

### Guardrail blocked new package.json creation
The Gemini adapter (8 files) was initially blocked because `**/package.json` was in the guardrail blockedPaths. The agent correctly created `packages/gemini/package.json` but the glob matched all package.json files.

**Fix:** Changed to `package.json` (root only). Agents can now create package.json in subdirectories.

### Test type errors with fetch mocks
Both AI-generated test files (Gemini adapter, GitHub Issues adapter) mock `globalThis.fetch` but Bun's fetch type includes a `preconnect` property. Tests pass at runtime but fail type checking.

**Fix:** Added `@ts-nocheck` to test files that mock fetch.

## Key Takeaways

1. **Claude Code Sonnet produces significantly better code than Gemma** — correct imports, proper bun:test usage, no syntax errors
2. **The Max plan makes Claude Code economically viable** — $1.23 for 5 PRs is negligible against a subscription
3. **Every agent having full codebase access changes the quality** — Claude Code reads files, understands patterns, follows conventions
4. **Guardrails need to be calibrated** — blocking all package.json was too aggressive for "create a new package" tasks
5. **The CTO should require documentation** — added to prompts after this sprint
