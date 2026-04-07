# @floor-agents/orchestrator

The main execution engine. Watches for tasks, dispatches to agents, manages the execution state machine, enforces guardrails and cost controls, and records dogfooding metrics.

## Structure

```
packages/orchestrator/src/
├── index.ts              ← re-exports
├── orchestrator.ts       ← main loop + state machine
├── dispatcher.ts         ← resolves which agent handles an issue
├── output-parser.ts      ← extracts files from LLM tool calls
├── guardrails.ts         ← validates agent output before commit
├── cost-tracker.ts       ← per-task and daily cost limits
├── state-store.ts        ← file-based execution state persistence
└── metrics-collector.ts  ← dogfooding metrics (Phase 1 spec §9.3)
```

## Usage

```typescript
import {
  createOrchestrator,
  createCostTracker,
  createStateStore,
  createMetricsCollector,
} from '@floor-agents/orchestrator'

const metricsCollector = await createMetricsCollector('./data/metrics.json')

const orchestrator = createOrchestrator({
  company,          // CompanyConfig
  taskAdapter,      // TaskAdapter
  gitAdapter,       // GitAdapter
  llmAdapters,      // Map<string, LLMAdapter>
  contextBuilder,   // ContextBuilder
  stateStore: createStateStore('./data/executions'),
  costTracker: createCostTracker(),
  metricsCollector, // optional — omit to disable metrics
})

await orchestrator.start()  // blocks until stopped
await orchestrator.stop()   // graceful shutdown
```

## Execution State Machine

Each task progresses through 10 steps. State is saved between each step for crash recovery.

```
pending → building_context → calling_llm → parsing_output → validating_output
  → creating_branch → committing_files → creating_pr → updating_issue → done
```

Any step can fail → `failed` (terminal). Failed tasks are labeled `needs-human` and commented with the error.

## Tool Use Conversation Loop

The orchestrator handles multi-turn tool use:

1. Call LLM with tools (`write_file`, `pr_description`)
2. If `stopReason === 'tool_use'`:
   - Collect tool calls
   - Send `tool_result` acknowledgments
   - Call LLM again
3. Repeat until `stopReason !== 'tool_use'` (or max 10 turns)
4. Combine all tool calls from all turns

This handles models that emit one file per turn (common with local models).

## Dispatcher

Resolves which agent handles an issue:

1. If the issue has a label matching an agent ID → that agent
2. Otherwise → first agent with `write_code` capability
3. No match → skip the issue

## Output Parser

Extracts structured data from LLM tool calls:

- `write_file` calls → `FileOutput[]` (path + content)
- `pr_description` call → PR title and body
- If no `write_file` calls → `parseErrors` (triggers retry)

## Guardrails

Validates agent output before committing. Returns `GuardrailViolation[]`:

| Check | Config Field |
|-------|-------------|
| File count | `maxFilesPerTask` |
| Individual file size | `maxFileSizeBytes` |
| Total output size | `maxTotalOutputBytes` |
| Blocked paths (glob) | `blockedPaths` |
| Allowed paths (glob) | `allowedPaths` |
| Blocked extensions | `blockedExtensions` |
| Path traversal (`..`, absolute) | Always checked |

If any violations → PR is not created, issue commented with details, labeled `needs-human`.

## Cost Tracker

Tracks spending in memory (resets on restart):

- `recordCost(taskId, cost)` — accumulate cost
- `canStartNewTask(costConfig)` — check daily limit
- `checkTaskCost(taskId, costConfig)` — check per-task limit + warning threshold

Daily cost resets at UTC midnight. Local models report $0.

## State Store

File-based JSON persistence for crash recovery:

- State files at `{stateDir}/{issueId}.json`
- Atomic writes: write to `.tmp`, then `rename` (prevents corruption on crash)
- On startup: loads all states, resumes incomplete tasks

## Metrics Collector

Tracks dogfooding quality metrics defined in Phase 1 spec §9.3. Persists to `data/metrics.json` and logs a summary table after each task.

### Metrics tracked

| Metric | Description |
|--------|-------------|
| **Parse success rate** | Successful LLM parses (≥1 file produced) / total LLM calls |
| **Compilable output rate** | Tasks where a PR was created / total tasks (PR creation = typecheck passed) |
| **Merge-ready rate** | PRs merged without manual edits / PRs with known merge status |
| **Avg cost per task** | Mean USD cost across all completed tasks |
| **Avg time to PR** | Mean ms from task start to PR creation |
| **Guardrail trigger rate** | Tasks blocked by guardrails / total tasks |
| **Crash recovery success rate** | Recovered tasks that completed / all recovered tasks |

### API

```typescript
const collector = await createMetricsCollector('./data/metrics.json')

collector.recordTaskStart(taskId, agentId, wasRecovered)
collector.recordLlmCall(taskId, parseSuccess)
collector.recordGuardrailResult(taskId, triggered, violationCount)
collector.recordPrCreated(taskId)
await collector.recordTaskComplete(taskId, 'done' | 'failed', costUsd, reviewCycles)

const summary: MetricsSummary = collector.getSummary()
collector.printSummary() // prints the box table to stdout
```

All `record*` methods are synchronous; `recordTaskComplete` is async (persists to disk).

### Storage format

```json
{
  "version": "1",
  "updatedAt": "2026-04-08T12:00:00.000Z",
  "tasks": [
    {
      "taskId": "ABC-123",
      "agentId": "backend",
      "startedAt": "2026-04-08T11:00:00.000Z",
      "completedAt": "2026-04-08T11:04:30.000Z",
      "status": "done",
      "llmCallCount": 3,
      "parseSuccessCount": 3,
      "prCreated": true,
      "prCreatedAt": "2026-04-08T11:04:00.000Z",
      "mergedWithoutEdits": null,
      "costUsd": 0.4821,
      "timeToPrMs": 240000,
      "guardrailTriggered": false,
      "guardrailViolationCount": 0,
      "wasRecovered": false,
      "reviewCycles": 1
    }
  ]
}
```

`mergedWithoutEdits` is `null` until set externally (e.g. a webhook handler). The merge-ready rate metric is omitted from the summary when no tasks have this data.

### Summary script

Print the current metrics without running the orchestrator:

```sh
bun run src/metrics.ts

# Custom path
METRICS_PATH=./data/metrics.json bun run src/metrics.ts
```

Example output:
```
┌───────────────────────────────────────────────┐
│  Dogfooding Metrics                           │
├───────────────────────────────────────────────┤
│  Total tasks                              12  │
│    Completed                              10  │
│    Failed                                  2  │
├───────────────────────────────────────────────┤
│  Parse success rate                    96.7%  │
│  Compilable output rate                83.3%  │
│  Merge-ready rate                       n/a   │
│  Avg cost per task                   $0.4821  │
│  Avg time to PR                        4m 0s  │
│  Guardrail trigger rate                16.7%  │
│  Crash recovery success                 n/a   │
└───────────────────────────────────────────────┘
```

## Crash Recovery

On startup, the orchestrator:

1. Lists all execution states from disk
2. Filters for incomplete (not `done` or `failed`)
3. Resumes each from its current step

Steps are idempotent:
- `createBranch` — 422 = exists → continue
- `createPR` — checks for existing open PR → reuse
- `commitFiles` — force-updates branch ref → overwrites partial state
- `addComment` — may duplicate a comment (acceptable)

Recovered tasks are flagged in metrics (`wasRecovered: true`) so crash recovery success rate can be calculated separately.

## Graceful Shutdown

`stop()` sets `running = false` and aborts the watch loop via `AbortController`. The orchestrator finishes any in-progress task before exiting.
