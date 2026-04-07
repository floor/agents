# @floor-agents/context-builder

Assembles the full context for an agent LLM call: selects relevant files from the repo, renders the system prompt with token budgeting, and defines the tools the agent can use.

## Structure

```
packages/context-builder/src/
├── index.ts              ← re-exports
├── builder.ts            ← createContextBuilder factory
├── file-selector.ts      ← keyword-based file selection
└── prompt-renderer.ts    ← system prompt assembly with token budget
```

## Usage

```typescript
import { createContextBuilder } from '@floor-agents/context-builder'

const builder = createContextBuilder({
  taskAdapter,
  gitAdapter,
})

const context = await builder.build({
  agent,          // AgentDefinition
  issue,          // Issue from task adapter
  project,        // ProjectConfig
})

// context.systemPrompt   — full system prompt with project context, files, instructions
// context.userMessage     — the task description for the user message
// context.tools           — write_file + pr_description tool definitions
// context.estimatedTokens — estimated token count
```

## File Selection (v2 — Keyword Matching + Import Tracing)

### Phase 1: Keyword Matching

The file selector extracts references from the issue text:

1. **File paths** — matches patterns like `src/foo/bar.ts`, `config.yaml`
2. **Route paths** — `/api/users` → maps to `{backend}/users.ts`
3. **Class identifiers** — `UserController` → maps to `{backend}/user_controller.ts`

Each match gets a relevance score:
- Direct file path match: **10**
- Route path match: **5**
- Identifier match: **3**

Files are sorted by relevance and fetched from the repo via the git adapter.

### Phase 2: Import Tracing

After fetching keyword-matched files, the selector reads each file's content and extracts its `import`/`export from` and dynamic `import()` specifiers. Relative specifiers are resolved to repo-root-relative paths and fetched if they exist.

Import-traced files receive a lower relevance score:
- Import-traced file: **1**

This means import-traced files are always lower priority than keyword-matched files and will be dropped first if the token budget is exceeded. Files already found in phase 1 are not duplicated.

## Prompt Rendering

The system prompt is assembled in sections:

1. **Role prompt** — loaded from the agent's `promptTemplate` file (e.g. `agents/backend-dev.md`)
2. **Project context** — language, runtime, conventions
3. **Directory tree** — repo structure overview
4. **Relevant files** — source files selected by the file selector
5. **Custom instructions** — from project config and agent config
6. **Output instructions** — tells the agent to use `write_file` and `pr_description` tools

### Token Budget

The renderer operates within a token budget:

```
Budget = maxContextTokens (default 100K) - reserved output tokens (4K)
```

Sections are added in priority order. If files exceed the budget, lowest-relevance files are dropped with a log message.

## Tool Definitions

The builder provides two tools for every agent:

**`write_file`** — create or modify a file
- `path` (string): file path relative to repo root
- `content` (string): complete file content

**`pr_description`** — set the PR title and description
- `title` (string): short PR title
- `description` (string): PR body in markdown

## Future Versions

- **v3 — Embeddings**: semantic file retrieval via vector search
- **v4 — AST-aware**: function signatures, export maps, structural understanding
