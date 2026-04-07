# Known Issues & Improvements

Tracked issues from the Phase 1 implementation review.

---

## Resolved

### 1. ~~Entry point is hardcoded — should be config-driven~~ ✅

**Fixed in:** `src/main.ts`

The entry point now:
- Scans `company.agents` for unique `llm.provider` values
- Only creates adapters for providers actually referenced by agents
- Only requires env vars for the providers in use (e.g. no `ANTHROPIC_API_KEY` needed if all agents use `lmstudio`)
- Reads `TASK_ADAPTER` env var to choose task adapter (`linear` or `things`)

### 2. ~~Prompt template variables are not replaced~~ ✅

**Fixed in:** `agents/backend-dev.md`, `packages/context-builder/src/prompt-renderer.ts`

Removed dead `{{variables}}` from templates. Templates are now pure role instructions — project context is injected as structured sections by the renderer. No template variable system needed.

### 3. ~~No integration test for the full pipeline~~ ✅

**Fixed in:** `test/orchestrator/integration.test.ts`

Five integration tests with fully mocked adapters:
- Happy path: issue → LLM → branch → PR → status update
- Guardrail violation: blocked path prevents PR creation
- No tool calls: retries once then fails gracefully
- Daily cost limit: skips new tasks when budget exhausted
- Crash recovery: resumes from saved execution state

### 4. ~~Default template has empty project config~~ ✅

**Fixed in:** `config/templates/default.yaml`, `packages/core/src/config/validator.ts`

- Default template now has `project.name: "floor-agents"` and `project.repo: "floor/agents"`
- Validator rejects empty `project.name` and `project.repo`

### 5. ~~Prompt templates missing for non-backend agents~~ ✅

**Fixed in:** `agents/`

All five agent prompt templates now exist:
- `agents/backend-dev.md`
- `agents/frontend-dev.md`
- `agents/pm.md`
- `agents/cto.md`
- `agents/qa.md`
