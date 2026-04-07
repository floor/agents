# Floor Agents — Phase 1 Specification

**Author:** CTO
**Date:** March 2026
**Updated:** April 2026
**Status:** Draft v3 — Implemented
**Approved by:** CEO

**Revision notes (v2):** Addresses six gaps from v1 review: fragile output parsing, missing guardrails, no idempotency, unused chain-of-command model, no cost controls, no dogfooding plan.

**Revision notes (v3 — implementation):** Phase 1 has been implemented. Key deviations from v2 spec:

| Area | v2 Spec | Implementation | Rationale |
|------|---------|----------------|-----------|
| **Output format** | XML-tagged (`<file>` blocks) | LLM tool use (`write_file`, `pr_description`) | Industry standard. Structured, typed, no parsing ambiguity. Anthropic/OpenAI support natively. |
| **Project structure** | `packages/` monorepo with separate `@floor-agents/linear` | `@floor-agents/task` umbrella package with factory pattern | Task adapters are small (~400 LoC). Single package with `createTaskAdapter({ type, config })` factory is cleaner for adding providers. |
| **Runtime** | Node.js, ESM | Bun, ESM | Decision D001 already specified Bun. Spec Section 9 was outdated. |
| **Things adapter** | Not in spec | Existed in prototype, removed | macOS-only, not needed for target architecture. |

All other spec decisions (data model, guardrails, cost controls, state machine, idempotency, config loader, adapter interfaces) were implemented as specified.

---

## 1. Objective

Ship the first complete loop:

```
Linear issue (labeled "floor")
  → Orchestrator picks it up
  → Context builder assembles relevant code + task
  → Backend Dev agent writes implementation
  → GitHub adapter creates branch + PR
  → Linear issue updated with PR link
```

Single tenant. Internal dogfooding. One agent role (using the default template). No web dashboard — config is a YAML file.

### 1.1 Success Criteria

- A Linear issue labeled `floor` triggers agent work within 60 seconds.
- The agent produces compilable, convention-following code.
- A GitHub PR is created with the agent's changes and a clear description.
- The Linear issue is updated with the PR link and moved to "In Review".
- The full execution is logged: tokens used, cost, duration, files touched.
- Process can crash at any point and resume cleanly on restart (idempotency).
- No single task can exceed the configured cost ceiling.

### 1.2 Out of Scope (Phase 1)

- Multiple agent roles executing in a single workflow (PM decomposition, CTO review, QA) — templates exist, engine doesn't execute them yet.
- Parallel execution, dependency graphs.
- Web dashboard.
- Multi-tenancy.
- Configuration UI for the virtual company.
- Custom workflow states beyond the default template.
- Revision cycles (CTO → agent → CTO).

---

## 2. Core Data Model — The Configurable Company

These types are the foundation. They support the full vision (any number of agents, any workflow, any chain of command) but Phase 1 only exercises a subset.

**Phase 1 vs. full model:** Types marked with `[PHASE 1: active]` are implemented and exercised. Types marked with `[PHASE 1: defined only]` are in the codebase and validated by the config loader, but the orchestrator does not use them yet. This keeps the data model honest without building dead code paths.

### 2.1 Agent Definition

An agent is a configured AI worker. No hardcoded roles. **[PHASE 1: active]**

```typescript
/**
 * An agent is a named AI worker with a role, a prompt,
 * an LLM configuration, a set of capabilities, and an autonomy level.
 *
 * The default template ships with: pm, cto, backend, frontend, qa.
 * Customers can modify these or create their own.
 */

interface AgentDefinition {
  /** Unique identifier within the company (e.g. 'backend-senior', 'qa-lead'). */
  readonly id: string

  /** Human-readable name (e.g. 'Senior Backend Developer'). */
  readonly name: string

  /** Path to the base prompt template (e.g. 'agents/backend-dev.md'). */
  readonly promptTemplate: string

  /** LLM configuration for this agent. */
  readonly llm: AgentLLMConfig

  /** What this agent is allowed to do. */
  readonly capabilities: readonly AgentCapability[]

  /** Default autonomy tier — can be overridden by autonomy rules. */
  readonly autonomy: AutonomyTier

  /** Optional per-agent custom instructions appended to the prompt. */
  readonly customInstructions: string
}

interface AgentLLMConfig {
  readonly provider: string    // 'anthropic', 'openai', etc.
  readonly model: string       // 'claude-sonnet-4-20250514', 'gpt-4o', etc.
  readonly temperature: number // 0.0–1.0
  readonly maxTokens: number   // max output tokens
}

type AgentCapability =
  | 'read_code'       // Can read files from the repo
  | 'write_code'      // Can produce file changes
  | 'create_pr'       // Can trigger PR creation
  | 'review_pr'       // Can review PR diffs
  | 'write_tests'     // Can produce test files
  | 'decompose_task'  // Can break issues into sub-issues
  | 'manage_issues'   // Can create/update/label issues
  | 'approve'         // Can approve (move to next stage)
  | 'reject'          // Can reject (send back for revision)

type AutonomyTier = 'T1' | 'T2' | 'T3'
// T1: Agent acts, human reviews at their pace
// T2: Agent recommends, waits for human approval
// T3: Agent presents options, human decides
```

### 2.2 Workflow Definition

The workflow is a set of customer-defined states and transitions. **[PHASE 1: defined only]**

Phase 1 uses a hardcoded two-step flow (pick up → create PR). The full state machine engine is Phase 2. But the data model is loaded and validated on startup so we know the config is valid before we need it.

```typescript
interface WorkflowDefinition {
  readonly states: readonly WorkflowStateDefinition[]
  readonly transitions: readonly TransitionDefinition[]
}

interface WorkflowStateDefinition {
  readonly id: string
  readonly label: string
  readonly taskManagerStatus: string
  readonly terminal: boolean
}

interface TransitionDefinition {
  readonly from: string
  readonly to: string
  readonly trigger: TransitionTrigger
  readonly agentId: string | null
  readonly maxCycles: number | null
  readonly fallbackState: string | null
}

type TransitionTrigger =
  | { type: 'label_added'; label: string }
  | { type: 'label_removed'; label: string }
  | { type: 'agent_completed' }
  | { type: 'review_approved' }
  | { type: 'review_rejected' }
  | { type: 'qa_passed' }
  | { type: 'qa_failed' }
  | { type: 'subtasks_created' }
  | { type: 'subtask_unblocked' }
  | { type: 'manual' }
  | { type: 'custom'; event: string }
```

### 2.3 Chain of Command

Defines how agents relate to each other. **[PHASE 1: defined only]**

Phase 1 dispatches work by matching issue labels to agent IDs directly — a flat lookup, not a graph traversal. The chain graph is loaded and validated (no orphan nodes, no cycles, all agentIds reference existing agents) but not traversed.

```typescript
interface ChainOfCommand {
  readonly nodes: readonly ChainNode[]
}

interface ChainNode {
  readonly agentId: string
  readonly receivesFrom: readonly WorkSource[]
  readonly dispatchesTo: readonly string[]
  readonly reportsTo: string | null
  readonly canApprove: boolean
  readonly canReject: boolean
}

type WorkSource =
  | { type: 'trigger' }
  | { type: 'agent'; id: string }
  | { type: 'workflow' }
```

### 2.4 Autonomy Rules

Configurable overrides for agent autonomy. **[PHASE 1: defined only]**

Phase 1 runs everything as T1 (fully autonomous). The autonomy config is loaded and validated but not evaluated at dispatch time. Phase 2 adds the evaluation engine.

```typescript
interface AutonomyConfig {
  readonly default: AutonomyTier
  readonly overrides: readonly AutonomyOverride[]
}

interface AutonomyOverride {
  readonly match: AutonomyMatch
  readonly tier: AutonomyTier
}

interface AutonomyMatch {
  readonly path?: string
  readonly label?: string
  readonly agentId?: string
  readonly action?: string
  readonly revisionCycle?: number
  readonly priority?: string
}
```

### 2.5 Guardrails

Safety boundaries on what agents can produce. **[PHASE 1: active]**

This was missing from v1. An autonomous agent without guardrails is dangerous. These constraints are enforced by the orchestrator before any files are committed.

```typescript
interface GuardrailsConfig {
  /** Maximum number of files an agent can create/modify in a single task. */
  readonly maxFilesPerTask: number

  /** Maximum size of any single file in bytes. */
  readonly maxFileSizeBytes: number

  /** Maximum total output size (all files combined) in bytes. */
  readonly maxTotalOutputBytes: number

  /**
   * Files the agent is never allowed to create or modify.
   * Glob patterns. Evaluated against file paths in the agent's output.
   */
  readonly blockedPaths: readonly string[]

  /**
   * Directories the agent is allowed to write to.
   * If set, agent output is restricted to these paths only.
   * Glob patterns. If empty, no restriction (except blockedPaths).
   */
  readonly allowedPaths: readonly string[]

  /**
   * File extensions the agent is not allowed to create.
   * e.g. ['.env', '.pem', '.key', '.lock']
   */
  readonly blockedExtensions: readonly string[]
}
```

Default guardrails in the default template:

```yaml
guardrails:
  maxFilesPerTask: 20
  maxFileSizeBytes: 102400       # 100 KB per file
  maxTotalOutputBytes: 512000    # 500 KB total
  blockedPaths:
    - ".env*"
    - "*.pem"
    - "*.key"
    - ".github/workflows/*"
    - "Dockerfile"
    - "docker-compose*"
    - "**/package.json"
    - "**/package-lock.json"
    - "**/bun.lockb"
    - ".gitignore"
  allowedPaths: []
  blockedExtensions:
    - ".env"
    - ".pem"
    - ".key"
    - ".lock"
    - ".exe"
    - ".bin"
```

**Guardrail enforcement (in the orchestrator, after parsing agent output):**

```typescript
interface GuardrailViolation {
  readonly type: 'too_many_files' | 'file_too_large' | 'total_too_large'
    | 'blocked_path' | 'outside_allowed_paths' | 'blocked_extension'
  readonly detail: string
  readonly file?: string
}

function validateAgentOutput(
  output: AgentOutput,
  guardrails: GuardrailsConfig,
): readonly GuardrailViolation[]
```

If any violations are found:
- The PR is **not** created.
- The Linear issue is commented with the violations list.
- The issue is labeled `needs-human`.
- The execution log records the violations.

### 2.6 Cost Controls

Per-task and per-day spending limits. **[PHASE 1: active]**

```typescript
interface CostConfig {
  /** Maximum estimated cost (USD) for a single agent call. */
  readonly maxCostPerTask: number

  /** Maximum total spend (USD) per calendar day across all tasks. */
  readonly maxCostPerDay: number

  /** Warn (comment on issue) when a single task exceeds this threshold. */
  readonly warnCostThreshold: number
}
```

Default cost controls:

```yaml
costs:
  maxCostPerTask: 5.00     # $5 per task — abort if exceeded
  maxCostPerDay: 50.00     # $50 per day — stop processing new tasks
  warnCostThreshold: 2.00  # $2 — comment a cost warning on the issue
```

**Enforcement:**

1. **Before calling the LLM:** Estimate the cost from context token count + max output tokens. If estimate exceeds `maxCostPerTask`, skip the call. Comment on the issue: "Estimated cost ($X.XX) exceeds limit ($Y.YY). Context may be too large — consider splitting the task or increasing the limit."

2. **After calling the LLM:** Record actual cost. If `warnCostThreshold` is exceeded, comment on the issue with actual cost.

3. **Per-day ceiling:** The orchestrator tracks total daily spend in memory (reset at midnight UTC). If `maxCostPerDay` is reached, stop picking up new issues. Comment on any pending issues: "Daily cost limit reached. Will resume tomorrow or when limit is increased."

4. **On restart:** Daily spend is lost (in-memory). Acceptable for Phase 1 — slightly more permissive than intended. Phase 2 persists this to the database.

### 2.7 Company Configuration

The top-level object that ties everything together.

```typescript
interface CompanyConfig {
  readonly id: string
  readonly name: string
  readonly project: ProjectConfig
  readonly agents: readonly AgentDefinition[]
  readonly workflow: WorkflowDefinition        // [PHASE 1: defined only]
  readonly chain: ChainOfCommand               // [PHASE 1: defined only]
  readonly autonomy: AutonomyConfig            // [PHASE 1: defined only]
  readonly guardrails: GuardrailsConfig        // [PHASE 1: active]
  readonly costs: CostConfig                   // [PHASE 1: active]
  readonly statusMapping: Record<string, string>
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface ProjectConfig {
  readonly name: string
  readonly repo: string
  readonly language: string
  readonly runtime: string
  readonly conventions: ProjectConventions
  readonly structure: ProjectStructure
  readonly packages: readonly string[]
  readonly customInstructions: string
}
```

---

## 3. Default Template

Phase 1 ships with one template: `default`. See Appendix A for the full YAML. Key additions from v1:
- `guardrails` section with safe defaults.
- `costs` section with reasonable ceilings.
- All agent, workflow, chain, and autonomy config unchanged from v1.

---

## 4. Agent Output Format

**This was identified as the most fragile part of the system in v1. This section replaces the vague "open question" with a concrete solution.**

### 4.1 Strategy: XML-Tagged Structured Output

LLMs are unreliable at producing strict JSON but excellent at producing XML-tagged sections within natural language. We use a hybrid approach:

- The agent writes naturally (plan, explanation, notes).
- File outputs are wrapped in strict XML tags that are trivial to parse.

**Prompt template output format (replaces the markdown-header approach from v1):**

```
Think through your approach, then provide your implementation.

Write your plan and any notes as regular text.

For each file you create or modify, wrap it in tags:

<file path="src/routes/users.ts">
// full file content here
</file>

<file path="test/routes/users.test.ts">
// full test file content here
</file>

After all files, write the PR description:

<pr_description>
## What this does
...
</pr_description>
```

### 4.2 Parser Implementation

```typescript
interface AgentOutput {
  readonly rawResponse: string
  readonly files: readonly FileOutput[]
  readonly prDescription: string
  readonly parseErrors: readonly string[]
}

interface FileOutput {
  readonly path: string
  readonly content: string
}
```

**Parsing rules:**

1. Extract all `<file path="...">...</file>` blocks using regex: `/<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g`
2. Extract `<pr_description>...</pr_description>` block.
3. Everything outside the tags is the agent's reasoning (logged but not used).
4. If zero `<file>` blocks are found, the parse has failed.
5. If `<pr_description>` is missing, synthesize one from the first 500 characters of the response.

**Why XML tags over JSON:**
- LLMs produce valid XML tags far more reliably than valid JSON (no escaping issues, no comma problems, no bracket matching).
- File content can contain any character including JSON special characters — no escaping needed inside XML CDATA-like blocks.
- Partial output is still parseable — if the response is truncated, we get all complete `<file>` blocks up to the truncation point.
- Human-readable in logs without a JSON formatter.

**Why not markdown headers (the v1 approach):**
- `## FILES` is ambiguous — the LLM might write `## Files`, `## File Changes`, or nest them differently.
- Extracting file content from markdown code blocks requires fragile heuristics to match file paths to blocks.
- XML tags have unambiguous start/end markers.

### 4.3 Fallback: Re-prompt on Parse Failure

If parsing extracts zero files:

1. Log the full raw response.
2. Send a single follow-up message to the same LLM conversation:
   ```
   Your response did not contain any <file> tags. Please provide your implementation
   using the exact format:

   <file path="path/to/file.ts">
   file content
   </file>
   ```
3. Parse the follow-up response.
4. If still no files → mark issue `needs-human`, comment with: "Agent could not produce structured output after retry."
5. Maximum 1 retry (2 total LLM calls per task for parsing). No infinite loops.

### 4.4 Output Validation Pipeline

After parsing, before committing:

```
Raw LLM response
  → Parse (extract <file> blocks)
  → Validate paths (no absolute paths, no path traversal, normalized)
  → Validate guardrails (file count, size, blocked paths, extensions)
  → Deduplicate (same path appears twice → last one wins, log warning)
  → Output: validated AgentOutput or list of violations
```

---

## 5. Idempotency and Crash Recovery

**The orchestrator can crash at any point. On restart, it must not create duplicate branches, duplicate PRs, or lose track of in-progress work.**

### 5.1 Execution State Machine

Each task progresses through discrete steps. The current step is persisted to disk (a simple JSON file) so it survives crashes.

```typescript
interface ExecutionState {
  readonly issueId: string
  readonly agentId: string
  readonly step: ExecutionStep
  readonly startedAt: string              // ISO 8601
  readonly branchName: string | null      // set after step 5
  readonly commitSha: string | null       // set after step 6
  readonly prUrl: string | null           // set after step 7
  readonly llmResponse: string | null     // set after step 2 (raw response, for debugging)
  readonly parsedOutput: AgentOutput | null // set after step 3
  readonly costUsd: number                // accumulated cost
  readonly error: string | null
  readonly updatedAt: string              // ISO 8601
}

type ExecutionStep =
  | 'pending'           // picked up, not started
  | 'building_context'  // assembling context
  | 'calling_llm'       // waiting for LLM response
  | 'parsing_output'    // parsing agent response
  | 'validating_output' // checking guardrails
  | 'creating_branch'   // creating git branch
  | 'committing_files'  // committing to branch
  | 'creating_pr'       // creating pull request
  | 'updating_issue'    // updating Linear issue with PR link
  | 'done'              // completed successfully
  | 'failed'            // terminal failure
```

### 5.2 State Persistence

State is stored at `./data/executions/{issueId}.json`. One file per task.

```typescript
interface StateStore {
  get(issueId: string): Promise<ExecutionState | null>
  save(state: ExecutionState): Promise<void>
  list(): Promise<readonly ExecutionState[]>
}
```

Phase 1 implementation: simple file I/O. Read/write JSON to disk. No database.

On save, write to `{issueId}.tmp` then rename to `{issueId}.json` (atomic on most filesystems). This prevents corrupted state from a crash mid-write.

### 5.3 Recovery Logic

On startup, the orchestrator:

1. Loads all execution states from `./data/executions/`.
2. For each state that is not `done` or `failed`:
   - Resume from the current step.
   - Steps are idempotent — safe to re-execute.

**Idempotency per step:**

| Step | Idempotent? | Strategy |
|------|:-----------:|----------|
| `building_context` | Yes | Rebuild context from scratch. |
| `calling_llm` | No | If we crashed here, we don't know if the call completed. **Re-call the LLM.** Acceptable cost (one extra call). |
| `parsing_output` | Yes | Re-parse from saved `llmResponse`. |
| `validating_output` | Yes | Re-validate from saved `parsedOutput`. |
| `creating_branch` | Yes | `createBranch` returns 422 if branch exists. Catch and continue. |
| `committing_files` | **No** | If we crashed mid-commit, the branch may have partial files. **Strategy: always force-push a fresh commit.** Create a new tree from scratch, create a new commit pointing to the base branch, update the branch ref. This overwrites any partial state. |
| `creating_pr` | Yes | Check if a PR already exists for this branch. If yes, use it. If no, create it. |
| `updating_issue` | Yes | Re-posting a comment is fine (might get a duplicate comment — acceptable for Phase 1). Status update is idempotent. |

### 5.4 Duplicate Detection

The orchestrator maintains a set of "known issue IDs" (loaded from execution state files on startup). When polling Linear for new issues:

- If an issue ID already has a state file → skip it (already processed or in progress).
- Only `done` and `failed` states are considered terminal. A `failed` task is not retried automatically — the human must re-label or create a new issue.

---

## 6. Phase 1 — Build Sequence

Six modules (core + five runtime modules), built in dependency order.

### 6.1 Module Dependency Graph

```
                    ┌──────────┐
                    │  @core   │  (types + config loader)
                    └────┬─────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
    ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼──────┐
    │  @linear  │  │  @github  │  │ @anthropic │
    │  adapter  │  │  adapter  │  │  adapter   │
    └─────┬─────┘  └─────┬─────┘  └─────┬──────┘
          │              │              │
          │         ┌────▼────┐         │
          │         │ @context│         │
          │         │ -builder│         │
          │         └────┬────┘         │
          │              │              │
          └──────────────┼──────────────┘
                         │
                  ┌──────▼───────┐
                  │ @orchestrator│
                  │  + guardrails│
                  │  + state     │
                  │  + cost ctrl │
                  └──────────────┘
```

### 6.2 Build Order

| Order | Module | Depends On | Effort |
|:-----:|--------|------------|:------:|
| 1 | `@floor-agents/core` | — | 1.5 days |
| 2a | `@floor-agents/anthropic` | core | 1 day |
| 2b | `@floor-agents/github` | core | 2 days |
| 2c | `@floor-agents/linear` | core | 2 days |
| 3 | `@floor-agents/context-builder` | core, github | 2 days |
| 4 | `@floor-agents/orchestrator` | all above | 4 days |

Modules 2a/2b/2c can be built in parallel.

**Total estimated: 10–13 working days to first loop.** (Up from 8–11 in v1 — the extra time is guardrails, state persistence, cost controls, and the output parser. Worth it.)

---

## 7. Module Specifications

### 7.1 @floor-agents/core

**Purpose:** Type definitions, config loading, shared utilities.

**Contents:**
- All TypeScript interfaces from Section 2 (Agent, Workflow, Chain, Autonomy, Guardrails, Costs, Company, Project)
- Adapter interfaces (TaskAdapter, GitAdapter, LLMAdapter) — unchanged from architecture doc
- Execution state types (Section 5.1)
- Config loader: reads YAML → validates → returns typed `CompanyConfig`
- Config validator: checks referential integrity (all agentIds in chain exist in agents list, all transition states exist in states list, no orphan nodes, no cycles in chain)
- Token estimation utility (`estimateTokens(text: string): number` — `Math.ceil(text.length / 4)`)
- Default template as a TypeScript constant (used when no YAML is provided)

**Test strategy:**
- Config loader: unit tests with valid and invalid YAML fixtures.
- Config validator: unit tests for each validation rule (missing agent ref, cycle detection, orphan nodes).
- Token estimation: sanity check tests.

---

### 7.2 @floor-agents/anthropic

**Purpose:** Call Anthropic's Messages API.

**Interface:**
```typescript
import type { LLMAdapter, LLMConfig, LLMResponse } from '@floor-agents/core'

interface AnthropicAdapterConfig {
  readonly apiKey: string
  readonly baseUrl?: string  // default: https://api.anthropic.com
}

function createAnthropicAdapter(config: AnthropicAdapterConfig): LLMAdapter
```

**Implementation details:**
- Uses `fetch` (no SDK dependency).
- Maps `LLMConfig` to Anthropic's `/v1/messages` request format.
- Maps Anthropic's response to `LLMResponse`.
- Cost estimation from a hardcoded pricing table (updated manually).
- Rate limiting: exponential backoff (3 retries, 1s/2s/4s delays).
- Timeout: 120 seconds per call.
- On 529 (overloaded): wait 10 seconds, retry once.

**Test strategy:** Unit tests with mocked fetch. One integration test (skipped in CI, requires real API key).

---

### 7.3 @floor-agents/github

**Purpose:** Read code and create PRs on GitHub.

**Interface:**
```typescript
import type { GitAdapter } from '@floor-agents/core'

interface GitHubAdapterConfig {
  readonly token: string
  readonly baseUrl?: string  // default: https://api.github.com
}

function createGitHubAdapter(config: GitHubAdapterConfig): GitAdapter
```

**Implementation details:**
- GitHub REST API v3 via `fetch`.
- `getFile`: GET `/repos/{owner}/{repo}/contents/{path}?ref={ref}` — base64 decode.
- `getTree`: GET `/repos/{owner}/{repo}/git/trees/{ref}?recursive=true` — filter by path prefix.
- `createBranch`: POST `/repos/{owner}/{repo}/git/refs`. **Idempotent: 422 = branch exists → return success.**
- `commitFiles`: Git Data API (blobs → tree → commit → update ref). **Idempotent: always creates a fresh tree and force-updates the branch ref.** This means a re-run replaces any partial commit cleanly.
- `createPR`: POST `/repos/{owner}/{repo}/pulls`. **Idempotent: check for existing PR on this branch first.** GET `/repos/{owner}/{repo}/pulls?head={branch}&state=open`. If found, return it. If not, create.
- `getPRDiff`: GET with `Accept: application/vnd.github.diff`.
- `addPRComment`: POST `/repos/{owner}/{repo}/issues/{id}/comments`.
- `mergePR`: PUT `/repos/{owner}/{repo}/pulls/{id}/merge`.
- `getRecentCommits`: GET `/repos/{owner}/{repo}/commits?path={path}&per_page={n}`.
- `getDefaultBranch`: GET `/repos/{owner}/{repo}` → `default_branch`.

**Error handling:**
- 401 → `AuthenticationError`
- 403 → `PermissionError`
- 404 → `NotFoundError`
- 422 → `ValidationError` (context-dependent — some 422s are idempotent successes)
- 429 → retry with `Retry-After` header

**Test strategy:** Unit tests with mocked fetch. Explicit tests for idempotent behaviors (createBranch when exists, createPR when exists, commitFiles overwriting previous).

---

### 7.4 @floor-agents/linear

**Purpose:** Watch for issues, read/write issues, comments, labels, statuses.

**Interface:**
```typescript
import type { TaskAdapter } from '@floor-agents/core'

interface LinearAdapterConfig {
  readonly apiKey: string
  readonly baseUrl?: string  // default: https://api.linear.app
}

function createLinearAdapter(config: LinearAdapterConfig): TaskAdapter
```

**Implementation details:**
- Linear GraphQL API via `fetch`.
- `watchIssues`: **Polling (Phase 1).** Every 30 seconds, query issues with `updatedAt` filter. Track the high-water mark timestamp to avoid re-processing.
- `getIssue`: GraphQL query by ID.
- `createIssue`: `issueCreate` mutation.
- `updateIssue`: `issueUpdate` mutation.
- `addComment`: `commentCreate` mutation. (**Not idempotent** — duplicate comments are possible on crash recovery. Acceptable for Phase 1.)
- `getComments`: `issue.comments` query.
- `setStatus`: `issueUpdate` with `stateId`. Fetches and caches Linear state IDs once on adapter creation.
- `addLabel` / `removeLabel`: mutations.
- `getRelations` / `createRelation`: queries/mutations.

**Test strategy:** Unit tests with mocked GraphQL responses.

---

### 7.5 @floor-agents/context-builder

**Purpose:** Assemble the full context for an agent LLM call.

**Interface:**
```typescript
interface ContextBuilder {
  build(params: BuildContextParams): Promise<AgentContext>
}

interface BuildContextParams {
  readonly agent: AgentDefinition
  readonly issueId: string
  readonly company: CompanyConfig
  readonly reviewComments?: string
  readonly previousAttempt?: string
}

interface ContextBuilderDeps {
  readonly taskAdapter: TaskAdapter
  readonly gitAdapter: GitAdapter
}

function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder
```

**Context assembly (in order):**

1. **Load prompt template** from disk. (Cached after first load.)

2. **Build project context** from `CompanyConfig.project`: language, runtime, conventions, structure, custom instructions.

3. **Build task context** from TaskAdapter: issue title, description, parent issue (if sub-task), comments, review notes.

4. **Select codebase files** (v1 — keyword matching):
   - Extract keywords from issue text: file names, directory names, function/class names, route paths.
   - Fetch repo tree from GitAdapter.
   - Match keywords against paths. Include structure-matching directories.
   - Fetch matched files.
   - Sort by relevance: direct name match > directory match > structure match.

5. **Apply token budget:**
   - Estimate tokens per layer.
   - If over budget, drop lowest-priority codebase files.
   - Log what was truncated.

6. **Render template:** Replace `{{PROJECT_CONTEXT}}`, `{{TASK_CONTEXT}}`, `{{CODEBASE_FILES}}`, `{{HISTORY}}` in the prompt template.

7. **Return `AgentContext`** with systemPrompt, userMessage, metadata.

**Test strategy:** Unit tests with fixture repos and issues. Test keyword extraction, file selection, and token budget truncation.

---

### 7.6 @floor-agents/orchestrator

**Purpose:** The main loop. Polls for tasks, dispatches to agents, manages state, enforces guardrails and cost controls.

**Interface:**
```typescript
interface Orchestrator {
  start(): Promise<void>
  stop(): Promise<void>
}

interface OrchestratorConfig {
  readonly company: CompanyConfig
  readonly taskAdapter: TaskAdapter
  readonly gitAdapter: GitAdapter
  readonly llmAdapters: ReadonlyMap<string, LLMAdapter>
  readonly contextBuilder: ContextBuilder
  readonly stateDir: string  // path to ./data/executions/
}

function createOrchestrator(config: OrchestratorConfig): Orchestrator
```

**Main loop:**

```
on start:
  1. Load existing execution states from disk
  2. Resume any incomplete tasks (see Section 5.3)
  3. Start polling loop

every 30 seconds:
  1. Check daily cost ceiling — if exceeded, skip
  2. Poll Linear for issues with "floor" label
  3. Filter out issues already in execution state
  4. For each new issue:
     a. Resolve agent:
        - If issue has label matching an agent ID → that agent
        - Otherwise → first agent with 'write_code' capability
     b. Create execution state (step: 'pending')
     c. Execute task pipeline (below)
```

**Task pipeline (sequential, one step at a time, state saved between steps):**

```
step 1: building_context
  → ContextBuilder.build(agent, issue, company)
  → Save state

step 2: calling_llm
  → Estimate cost. If > maxCostPerTask → fail with cost error
  → LLMAdapter.run(context)
  → Save raw response + actual cost to state

step 3: parsing_output
  → Parse <file> and <pr_description> tags
  → If parse fails → retry prompt (Section 4.3)
  → If still fails → fail state, comment on issue
  → Save parsed output to state

step 4: validating_output
  → Run guardrail validation (Section 2.5)
  → If violations → fail state, comment violations on issue
  → Save state

step 5: creating_branch
  → GitAdapter.createBranch (idempotent)
  → Save branchName to state

step 6: committing_files
  → GitAdapter.commitFiles (idempotent via force-push)
  → Save commitSha to state

step 7: creating_pr
  → GitAdapter.createPR (idempotent — checks existing)
  → Save prUrl to state

step 8: updating_issue
  → TaskAdapter.addComment(prUrl)
  → TaskAdapter.setStatus("In Review")
  → Mark state as 'done'

on any error:
  → Save error to state
  → Mark state as 'failed'
  → Comment on issue: "Floor Agents encountered an error: {error}"
  → Label issue 'needs-human'
```

**Submodules within the orchestrator package:**

| File | Responsibility |
|------|---------------|
| `orchestrator.ts` | Main loop, polling, task pipeline |
| `dispatcher.ts` | Resolves which agent handles an issue |
| `output-parser.ts` | XML-tag extraction (Section 4) |
| `guardrails.ts` | Output validation (Section 2.5) |
| `cost-tracker.ts` | Daily spend tracking (Section 2.6) |
| `state-store.ts` | File-based JSON persistence (Section 5.2) |

**Test strategy:**
- Output parser: unit tests with sample LLM responses (valid, missing files, malformed tags, truncated).
- Guardrails: unit tests for each violation type.
- Cost tracker: unit tests for limits, day rollover.
- State store: unit tests for save/load/resume.
- Full pipeline: integration test with all adapters mocked, including crash-and-resume scenarios.

---

## 8. Entry Point

```typescript
// src/main.ts

import { loadCompanyConfig } from '@floor-agents/core'
import { createLinearAdapter } from '@floor-agents/linear'
import { createGitHubAdapter } from '@floor-agents/github'
import { createAnthropicAdapter } from '@floor-agents/anthropic'
import { createContextBuilder } from '@floor-agents/context-builder'
import { createOrchestrator } from '@floor-agents/orchestrator'

const company = loadCompanyConfig(
  process.env.CONFIG_PATH ?? './config/company.yaml'
)

const linear = createLinearAdapter({
  apiKey: process.env.LINEAR_API_KEY!,
})

const github = createGitHubAdapter({
  token: process.env.GITHUB_TOKEN!,
})

const anthropic = createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

const contextBuilder = createContextBuilder({
  taskAdapter: linear,
  gitAdapter: github,
})

const orchestrator = createOrchestrator({
  company,
  taskAdapter: linear,
  gitAdapter: github,
  llmAdapters: new Map([['anthropic', anthropic]]),
  contextBuilder,
  stateDir: process.env.STATE_DIR ?? './data/executions',
})

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...')
  await orchestrator.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await orchestrator.stop()
  process.exit(0)
})

await orchestrator.start()
```

**Environment variables:**
```bash
LINEAR_API_KEY=lin_api_...
GITHUB_TOKEN=ghp_...
ANTHROPIC_API_KEY=sk-ant-...
CONFIG_PATH=./config/company.yaml    # optional, defaults shown
STATE_DIR=./data/executions          # optional, defaults shown
```

---

## 9. Dogfooding Plan

**Phase 1 is tested against the Floor Agents repo itself.** We eat our own cooking.

### 9.1 Test Repo

- **Repo:** `floor/agents` (this repo)
- **Project config:** TypeScript, Bun, ESM, Biome, conventions from the vlist skill.
- **Why this repo:** We know the codebase intimately. We can judge quality immediately. Every bug in Floor Agents can be filed as a Floor Agents issue.

### 9.2 Test Protocol

**Week 1 — Controlled tests (manual trigger, observed):**

Run 10 handcrafted issues of increasing complexity:

| # | Issue | Complexity | Success Criteria |
|---|-------|:----------:|------------------|
| 1 | "Add a `slugify` utility function to `packages/core/src/utils/`" | Trivial | Correct function, exported, basic tests |
| 2 | "Add JSDoc comments to all exported types in `packages/core/src/types/agent.ts`" | Trivial | Accurate docs, no type changes |
| 3 | "Add a `retryWithBackoff` utility to `packages/core/src/utils/`" | Simple | Correct implementation, configurable retries/delays, tests |
| 4 | "Implement `estimateCost` in the Anthropic adapter based on the pricing table" | Medium | Correct pricing, handles unknown models gracefully |
| 5 | "Add request logging to the GitHub adapter — log method, URL, status, duration" | Medium | Non-intrusive, structured log output |
| 6 | "Implement `getFile` and `getTree` in the GitHub adapter" | Medium | Correct API calls, base64 decoding, error handling |
| 7 | "Implement `getIssue` and `getComments` in the Linear adapter" | Medium | Correct GraphQL queries, type mapping |
| 8 | "Add config validation: detect cycles in the chain of command graph" | Hard | Graph cycle detection, clear error messages |
| 9 | "Implement the token budget allocator in the context builder" | Hard | Correct prioritization, truncation, logging |
| 10 | "Implement the full output parser with XML tag extraction and fallback" | Hard | Handles all cases from Section 4 |

**For each test, record:**
- Did the agent produce a compilable PR? (yes/no)
- Did the code follow conventions? (yes/partial/no)
- Were tests included? (yes/no)
- Were the right files selected by context builder? (yes/partial/no)
- Token count and cost
- Total time (poll → PR created)
- Number of guardrail violations (if any)
- Manual edits needed before merge (count lines changed)

### 9.3 Quality Metrics

Track across all dogfood runs:

| Metric | Target (Phase 1) | Measurement |
|--------|:-----------------:|-------------|
| **Parse success rate** | > 95% | Successful parses / total LLM calls |
| **Compilable output rate** | > 80% | PRs that pass type check / total PRs |
| **Merge-ready rate** | > 50% | PRs merged without edits / total PRs |
| **Avg cost per task** | < $2.00 | Total spend / total tasks |
| **Avg time to PR** | < 3 min | Poll detection → PR created |
| **Guardrail trigger rate** | < 10% | Tasks blocked by guardrails / total tasks |
| **Crash recovery success** | 100% | Resumed tasks completed / resumed tasks attempted |

### 9.4 Feedback Loop

After each dogfood batch:
1. Review metrics.
2. Identify the top failure mode (bad context? bad parsing? wrong files?).
3. File a Linear issue for the fix. (Yes, the agents will eventually fix themselves.)
4. Adjust prompt templates, guardrails, or context builder based on findings.
5. Repeat.

### 9.5 When Phase 1 Is Done

Phase 1 is complete when:
- All 10 test issues have been run at least once.
- Parse success rate is above 95%.
- Compilable output rate is above 80%.
- Crash recovery works (tested by killing the process mid-pipeline at each step).
- At least 3 PRs have been merged without manual edits.

---

## 10. File Structure (Phase 1)

```
floor-agents/
├── README.md
├── LICENSE
├── package.json
├── tsconfig.json
├── biome.json
├── .gitignore
│
├── config/
│   └── templates/
│       └── default.yaml
│
├── agents/
│   ├── backend-dev.md
│   ├── frontend-dev.md
│   ├── cto.md
│   ├── pm.md
│   └── qa.md
│
├── data/
│   └── executions/          # Runtime state (gitignored)
│
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types/
│   │       │   ├── agent.ts
│   │       │   ├── workflow.ts
│   │       │   ├── chain.ts
│   │       │   ├── autonomy.ts
│   │       │   ├── guardrails.ts
│   │       │   ├── costs.ts
│   │       │   ├── company.ts
│   │       │   ├── project.ts
│   │       │   ├── adapters.ts
│   │       │   └── execution.ts
│   │       ├── config/
│   │       │   ├── loader.ts
│   │       │   └── validator.ts
│   │       └── utils/
│   │           └── tokens.ts
│   │
│   ├── anthropic/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── adapter.ts
│   │       └── pricing.ts
│   │
│   ├── github/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── adapter.ts
│   │       └── api.ts
│   │
│   ├── linear/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── adapter.ts
│   │       └── graphql.ts
│   │
│   ├── context-builder/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── builder.ts
│   │       ├── file-selector.ts
│   │       └── prompt-renderer.ts
│   │
│   └── orchestrator/
│       └── src/
│           ├── index.ts
│           ├── orchestrator.ts
│           ├── dispatcher.ts
│           ├── output-parser.ts
│           ├── guardrails.ts
│           ├── cost-tracker.ts
│           └── state-store.ts
│
├── src/
│   └── main.ts
│
└── docs/
    ├── ARCHITECTURE.md
    └── PHASE1-SPEC.md
```

---

## 11. Decisions Log

| ID | Tier | Decision | Rationale | Date |
|----|------|----------|-----------|------|
| D001 | T3 | TypeScript on Bun, not Rust | I/O orchestration, not computation. Speed to ship > speed of execution. LLM ecosystem is TS-first. | 2026-03-31 |
| D002 | T3 | Monorepo with Bun workspaces | Clean package boundaries while keeping everything in one repo. | 2026-03-31 |
| D003 | T3 | Option B — generic configurable engine from day one | No rewrite later. MVP scope stays the same. Risk: over-engineering. Mitigated by marking what's "defined only" vs "active" in Phase 1. | 2026-03-31 |
| D004 | T2 | Polling Linear (not webhooks) in Phase 1 | Simpler. No webhook endpoint needed. 30-second delay acceptable for MVP. | 2026-03-31 |
| D005 | T1 | Biome for linting/formatting | Fast, single tool, good TS support. | 2026-03-31 |
| D006 | T1 | No SDK dependencies for API calls | Native fetch. Fewer deps, Bun-native. | 2026-03-31 |
| D007 | T2 | XML-tagged output format (not JSON, not markdown) | More reliable than JSON (no escaping). More parseable than markdown (unambiguous delimiters). Graceful on truncation. | 2026-03-31 |
| D008 | T2 | File-based state persistence (not database) for Phase 1 | Simple, no dependencies. Atomic writes via tmp+rename. Sufficient for single-tenant single-process. Database in Phase 3. | 2026-03-31 |
| D009 | T2 | Force-push strategy for commit idempotency | Always create a fresh tree and update branch ref. Overwrites partial state cleanly. No merge conflicts with self. | 2026-03-31 |
| D010 | T2 | Dogfood against floor/agents repo | We know the codebase. We can judge quality. The agents will eventually improve themselves. | 2026-03-31 |

---

## Appendix A — Default Template

```yaml
# config/templates/default.yaml

name: "Default Team"

agents:
  - id: pm
    name: "Project Manager"
    promptTemplate: "agents/pm.md"
    llm:
      provider: anthropic
      model: claude-sonnet-4-20250514
      temperature: 0.3
      maxTokens: 4000
    capabilities: [decompose_task, manage_issues]
    autonomy: T1
    customInstructions: ""

  - id: backend
    name: "Backend Developer"
    promptTemplate: "agents/backend-dev.md"
    llm:
      provider: anthropic
      model: claude-sonnet-4-20250514
      temperature: 0.2
      maxTokens: 8000
    capabilities: [read_code, write_code, create_pr, write_tests]
    autonomy: T1
    customInstructions: ""

  - id: frontend
    name: "Frontend Developer"
    promptTemplate: "agents/frontend-dev.md"
    llm:
      provider: anthropic
      model: claude-sonnet-4-20250514
      temperature: 0.2
      maxTokens: 8000
    capabilities: [read_code, write_code, create_pr, write_tests]
    autonomy: T1
    customInstructions: ""

  - id: cto
    name: "CTO / Tech Lead"
    promptTemplate: "agents/cto.md"
    llm:
      provider: anthropic
      model: claude-sonnet-4-20250514
      temperature: 0.3
      maxTokens: 4000
    capabilities: [read_code, review_pr, approve, reject]
    autonomy: T1
    customInstructions: ""

  - id: qa
    name: "QA Engineer"
    promptTemplate: "agents/qa.md"
    llm:
      provider: anthropic
      model: claude-sonnet-4-20250514
      temperature: 0.2
      maxTokens: 6000
    capabilities: [read_code, write_tests, approve, reject]
    autonomy: T1
    customInstructions: ""

workflow:
  states:
    - { id: backlog,           label: "Backlog",            taskManagerStatus: "Backlog",      terminal: false }
    - { id: triage,            label: "Triage",             taskManagerStatus: "Triage",       terminal: false }
    - { id: in_progress,       label: "In Progress",        taskManagerStatus: "In Progress",  terminal: false }
    - { id: in_review,         label: "In Review",          taskManagerStatus: "In Review",    terminal: false }
    - { id: changes_requested, label: "Changes Requested",  taskManagerStatus: "In Progress",  terminal: false }
    - { id: qa,                label: "QA",                 taskManagerStatus: "In Review",    terminal: false }
    - { id: done,              label: "Done",               taskManagerStatus: "Done",         terminal: true  }
    - { id: needs_human,       label: "Needs Human",        taskManagerStatus: "Blocked",      terminal: false }

  transitions:
    - { from: backlog,           to: triage,            trigger: { type: label_added, label: "floor" }, agentId: pm }
    - { from: triage,            to: in_progress,       trigger: { type: subtasks_created },            agentId: null }
    - { from: in_progress,       to: in_review,         trigger: { type: agent_completed },             agentId: cto }
    - { from: in_review,         to: qa,                trigger: { type: review_approved },             agentId: qa }
    - { from: in_review,         to: changes_requested, trigger: { type: review_rejected },             agentId: null, maxCycles: 3, fallbackState: needs_human }
    - { from: changes_requested, to: in_progress,       trigger: { type: manual },                     agentId: null }
    - { from: qa,                to: done,              trigger: { type: qa_passed },                   agentId: null }
    - { from: qa,                to: changes_requested, trigger: { type: qa_failed },                   agentId: null }

chain:
  nodes:
    - agentId: pm
      receivesFrom: [{ type: trigger }]
      dispatchesTo: [backend, frontend]
      reportsTo: null
      canApprove: false
      canReject: false

    - agentId: backend
      receivesFrom: [{ type: agent, id: pm }, { type: agent, id: cto }]
      dispatchesTo: []
      reportsTo: cto
      canApprove: false
      canReject: false

    - agentId: frontend
      receivesFrom: [{ type: agent, id: pm }, { type: agent, id: cto }]
      dispatchesTo: []
      reportsTo: cto
      canApprove: false
      canReject: false

    - agentId: cto
      receivesFrom: [{ type: workflow }]
      dispatchesTo: [backend, frontend]
      reportsTo: null
      canApprove: true
      canReject: true

    - agentId: qa
      receivesFrom: [{ type: workflow }]
      dispatchesTo: []
      reportsTo: null
      canApprove: true
      canReject: true

autonomy:
  default: T1
  overrides: []

guardrails:
  maxFilesPerTask: 20
  maxFileSizeBytes: 102400
  maxTotalOutputBytes: 512000
  blockedPaths:
    - ".env*"
    - "*.pem"
    - "*.key"
    - ".github/workflows/*"
    - "Dockerfile"
    - "docker-compose*"
    - "**/package.json"
    - "**/package-lock.json"
    - "**/bun.lockb"
    - ".gitignore"
  allowedPaths: []
  blockedExtensions: [".env", ".pem", ".key", ".lock", ".exe", ".bin"]

costs:
  maxCostPerTask: 5.00
  maxCostPerDay: 50.00
  warnCostThreshold: 2.00

statusMapping:
  backlog: "Backlog"
  triage: "Triage"
  in_progress: "In Progress"
  in_review: "In Review"
  changes_requested: "In Progress"
  qa: "In Review"
  done: "Done"
  needs_human: "Blocked"
```

---

*Ship the loop. Safely. Then iterate.*
