# @floor-agents/core

The foundation package. Contains all type definitions, the config loader, config validator, and shared utilities. Every other package depends on this.

## Structure

```
packages/core/src/
├── index.ts                 ← barrel re-export
├── types/
│   ├── adapters.ts          ← TaskAdapter, GitAdapter, LLMAdapter + supporting types
│   ├── agent.ts             ← AgentDefinition, AgentCapability, AutonomyTier
│   ├── company.ts           ← CompanyConfig (top-level)
│   ├── project.ts           ← ProjectConfig, conventions, structure
│   ├── guardrails.ts        ← GuardrailsConfig, GuardrailViolation
│   ├── costs.ts             ← CostConfig
│   ├── execution.ts         ← ExecutionState, ExecutionStep, AgentOutput
│   ├── workflow.ts          ← WorkflowDefinition (Phase 1: defined only)
│   ├── chain.ts             ← ChainOfCommand (Phase 1: defined only)
│   └── autonomy.ts          ← AutonomyConfig (Phase 1: defined only)
├── config/
│   ├── loader.ts            ← loadCompanyConfig(path?) → CompanyConfig
│   └── validator.ts         ← validateCompanyConfig(config) → string[]
└── utils/
    └── tokens.ts            ← estimateTokens(text) → number
```

## Key Types

### Adapter Interfaces

All adapters are defined as `type` (not `interface`), per project conventions.

**`TaskAdapter`** — watches for issues, CRUD on issues/comments/labels/statuses. Implemented by `@floor-agents/task`.

**`GitAdapter`** — reads files/trees, creates branches/commits/PRs. Implemented by `@floor-agents/github`.

**`LLMAdapter`** — calls an LLM with tool definitions, returns structured tool calls. Implemented by `@floor-agents/anthropic`, `@floor-agents/lmstudio`, `@floor-agents/openai`.

### LLM Tool Use Types

The LLM adapter supports structured output via tool use:

- `ToolDefinition` — name, description, JSON schema for inputs
- `ToolCall` — id, name, parsed input object
- `ContentBlock` — union of `text`, `tool_use`, `tool_result` blocks
- `LLMMessage` — role + content (string or ContentBlock array)
- `LLMResponse` — content, toolCalls, stopReason, usage, timing

### CompanyConfig

Top-level config that ties everything together. Loaded from YAML.

References: `ProjectConfig`, `AgentDefinition[]`, `WorkflowDefinition`, `ChainOfCommand`, `AutonomyConfig`, `GuardrailsConfig`, `CostConfig`.

## Config Loader

```typescript
import { loadCompanyConfig } from '@floor-agents/core'

const config = await loadCompanyConfig('config/my-team.yaml')
// Falls back to config/templates/default.yaml if no path given
```

Uses the `yaml` npm package for parsing. Returns a fully typed `CompanyConfig`.

## Config Validator

```typescript
import { validateCompanyConfig } from '@floor-agents/core'

const errors = validateCompanyConfig(config)
if (errors.length > 0) {
  // errors is string[] — each describes a validation failure
}
```

Validates:
- `project.name` and `project.repo` are non-empty
- At least one agent defined, each with id/name/promptTemplate/capabilities
- All agent IDs referenced in workflow transitions exist
- All state IDs referenced in transitions exist
- No cycles in chain of command (DFS)
- Guardrails and cost values are positive
- Warning threshold doesn't exceed max cost per task

## Token Estimation

```typescript
import { estimateTokens } from '@floor-agents/core'

estimateTokens('hello world') // → 3 (Math.ceil(11 / 4))
```

Rough estimation at ~4 characters per token. Used by the context builder for budget allocation.
