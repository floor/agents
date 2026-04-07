# @floor-agents/claude-code

LLM adapter that spawns [Claude Code](https://claude.com/claude-code) as a subprocess. Gives agents full codebase access — they can read files, run commands, understand project conventions via `CLAUDE.md`.

Best used for the CTO/reviewer role where deep codebase understanding matters more than speed.

## Structure

```
packages/claude-code/src/
├── index.ts       ← re-exports
└── adapter.ts     ← createClaudeCodeAdapter
```

## Usage

```typescript
import { createClaudeCodeAdapter } from '@floor-agents/claude-code'

const adapter = createClaudeCodeAdapter({
  cwd: '/path/to/repo',      // working directory for Claude Code
  model: 'opus',              // opus, sonnet, haiku
  maxTurns: 10,               // max agent turns
  allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'LSP'],
})
```

## How It Works

Unlike API-based adapters that send a request and get a response, this adapter:

1. Spawns `claude -p <prompt> --output-format json` as a child process
2. Claude Code runs as a full agent — reads files, explores the codebase, reasons about the code
3. Returns structured JSON with the result, cost, and token usage
4. The adapter extracts tool calls (e.g. `review_verdict`) from the response

## Config in YAML

```yaml
agents:
  - id: cto
    name: "CTO / Tech Lead"
    promptTemplate: "agents/cto.md"
    llm:
      provider: claude-code
      model: opus                    # uses Opus 4.6 for deep reasoning
      temperature: 0.3
      maxTokens: 16000
    capabilities: [read_code, review_pr, approve, reject]
```

No API key needed — Claude Code uses its own authentication.

## Capabilities

Because Claude Code is a full agent (not just an LLM), it can:

- **Read any file** in the repository
- **Search the codebase** with glob and grep
- **Run commands** like `bun run typecheck` or `bun test`
- **Understand conventions** from `CLAUDE.md`
- **Follow imports** and understand the dependency graph

This makes it far more effective as a reviewer than an API call that only sees a diff.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `cwd` | `process.cwd()` | Working directory — should be the repo root |
| `model` | Claude Code default | `opus`, `sonnet`, or `haiku` |
| `maxTurns` | 10 | Max agent turns before stopping |
| `allowedTools` | All | Array of allowed Claude Code tools |

## Timeouts

- **10-minute timeout** — Claude Code can take several minutes for thorough reviews
- The process is killed if it exceeds the timeout

## Cost

Claude Code reports actual cost in its JSON output. For Opus 4.6:
- ~$0.10-0.50 per review depending on codebase size and complexity
- Cached context reduces cost on subsequent reviews

## Allowed Tools

For a reviewer, restrict tools to read-only:

```typescript
allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'LSP']
```

For a dev agent (future), you might allow write tools:

```typescript
allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'LSP']
```
