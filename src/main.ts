import { loadCompanyConfig, validateCompanyConfig, computeRequiredProviders } from '@floor-agents/core'
import type { LLMAdapter } from '@floor-agents/core'
import { createAnthropicAdapter } from '@floor-agents/anthropic'
import { createOpenAIAdapter } from '@floor-agents/openai'
import { createLMStudioAdapter } from '@floor-agents/lmstudio'
import { createClaudeCodeAdapter } from '@floor-agents/claude-code'
import { createGeminiAdapter } from '@floor-agents/gemini'
import { createGitHubAdapter } from '@floor-agents/github'
import { createTaskAdapter } from '@floor-agents/task'
import { createContextBuilder } from '@floor-agents/context-builder'
import { createOrchestrator, createCommitteeOrchestrator, createCostTracker, createStateStore } from '@floor-agents/orchestrator'
import { createDiscussionsAdapter } from '@floor-agents/github'
import { createGateway } from '@floor-agents/gateway'
import { mkdir } from 'node:fs/promises'

// ── CLI flags (handle before any startup work) ───────────────────
const VERSION = (
  await Bun.file(new URL('../package.json', import.meta.url)).json().catch(() => ({ version: '0.0.0' }))
).version as string

const argv = Bun.argv.slice(2)

if (argv.includes('-v') || argv.includes('--version')) {
  console.log(VERSION)
  process.exit(0)
}

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`floor-agents v${VERSION} — autonomous multi-agent code review & development

Usage:
  floor-agents              Start the orchestrator (set CONFIG_PATH)
  floor-agents --help       Show this help
  floor-agents --version    Show the version

Environment:
  CONFIG_PATH   Path to your team config YAML (required)
  TASK_ADAPTER  linear | things | github-issues  (default: linear)
  STATE_DIR     Execution state directory        (default: ./data/executions)
  Plus GITHUB_TOKEN / GITHUB_OWNER and the provider + task-manager keys your config uses.

Requires Bun. Docs: https://github.com/floor/agents`)
  process.exit(0)
}

// Environment
const STATE_DIR = process.env.STATE_DIR ?? './data/executions'
const TASK_ADAPTER = process.env.TASK_ADAPTER ?? 'linear'
// Trigger tags the committee watches (comma-separated).
const COMMITTEE_LABELS = (process.env.COMMITTEE_LABELS ?? 'committee,agents')
  .split(',').map(s => s.trim()).filter(Boolean)

// Resolve config. Require CONFIG_PATH explicitly unless a local default template
// is present (dev) — so the published bin fails with a clear message instead of
// crashing on a CWD-relative default that isn't shipped.
const CONFIG_PATH = process.env.CONFIG_PATH
if (!CONFIG_PATH && !(await Bun.file('config/templates/default.yaml').exists())) {
  console.error('floor-agents: no config found.\n')
  console.error('Set CONFIG_PATH to your team config (YAML), e.g.:')
  console.error('  CONFIG_PATH=./agents.yaml floor-agents\n')
  console.error('Config format: https://github.com/floor/agents#configuration')
  console.error('Run `floor-agents --help` for usage.')
  process.exit(1)
}

// Load and validate config
const company = await loadCompanyConfig(CONFIG_PATH)
const errors = validateCompanyConfig(company)

if (errors.length > 0) {
  console.error('Config validation errors:')
  for (const err of errors) console.error(`  - ${err}`)
  process.exit(1)
}

// Determine which LLM providers are needed from agent definitions.
// External agents (Codex, Antigravity) run via the gateway, not an in-process
// LLM adapter, so they don't require their provider's API key.
const requiredProviders = computeRequiredProviders(company.agents)

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

// Create LLM adapters — only for providers referenced by agents
const llmAdapters = new Map<string, LLMAdapter>()

if (requiredProviders.has('anthropic')) {
  const adapter = createAnthropicAdapter({
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
  })
  llmAdapters.set('anthropic', adapter)
}

if (requiredProviders.has('claude-code')) {
  const adapter = createClaudeCodeAdapter({
    cwd: process.cwd(),
    model: process.env.CLAUDE_CODE_MODEL,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'LSP'],
  })
  llmAdapters.set('claude-code', adapter)
}

if (requiredProviders.has('lmstudio')) {
  const adapter = createLMStudioAdapter({
    baseUrl: process.env.LMSTUDIO_BASE_URL,
    apiKey: process.env.LMSTUDIO_API_KEY,
  })
  llmAdapters.set('lmstudio', adapter)
}

if (requiredProviders.has('gemini')) {
  const adapter = createGeminiAdapter({
    apiKey: requireEnv('GEMINI_API_KEY'),
  })
  llmAdapters.set('gemini', adapter)
}

const openaiCompatible = ['openai', 'ollama', 'local']
if (openaiCompatible.some(p => requiredProviders.has(p))) {
  const adapter = createOpenAIAdapter({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
  })
  for (const provider of openaiCompatible) {
    if (requiredProviders.has(provider)) {
      llmAdapters.set(provider, adapter)
    }
  }
}

// Verify all required providers have adapters
for (const provider of requiredProviders) {
  if (!llmAdapters.has(provider)) {
    throw new Error(`No LLM adapter available for provider "${provider}" (used by agent "${company.agents.find(a => a.llm.provider === provider)?.id}")`)
  }
}

// Create task adapter — driven by env var
const task = (() => {
  switch (TASK_ADAPTER) {
    case 'linear':
      return createTaskAdapter({
        type: 'linear',
        linear: {
          apiKey: requireEnv('LINEAR_API_KEY'),
          teamId: requireEnv('LINEAR_TEAM_ID'),
          projectId: process.env.LINEAR_PROJECT_ID,
        },
      })
    case 'things':
      return createTaskAdapter({ type: 'things' })
    case 'github-issues':
      return createTaskAdapter({
        type: 'github-issues',
        githubIssues: {
          token: requireEnv('GITHUB_TOKEN'),
          owner: requireEnv('GITHUB_OWNER'),
          repo: requireEnv('GITHUB_ISSUES_REPO'),
        },
      })
    default:
      throw new Error(`Unknown TASK_ADAPTER: ${TASK_ADAPTER}`)
  }
})()

// Create git adapter
const github = createGitHubAdapter({
  token: requireEnv('GITHUB_TOKEN'),
  owner: requireEnv('GITHUB_OWNER'),
})

// Create context builder
const contextBuilder = createContextBuilder({
  taskAdapter: task,
  gitAdapter: github,
})

// Ensure state directory exists
await mkdir(STATE_DIR, { recursive: true })

// Detect mode: committee if any agent has 'vote' capability, dev otherwise
const isCommitteeMode = company.agents.some(a => a.capabilities.includes('vote'))
const hasExternalAgents = company.agents.some(a => a.external)

const stateStore = createStateStore(STATE_DIR)
const costTracker = createCostTracker()

// Start gateway if external agents are configured
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT ?? '3100', 10)
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN
const gateway = hasExternalAgents
  ? createGateway({ port: GATEWAY_PORT, token: GATEWAY_TOKEN })
  : undefined

if (gateway) gateway.start()

const orchestrator = isCommitteeMode
  ? createCommitteeOrchestrator({
      company,
      taskAdapter: task,
      gitAdapter: github,
      llmAdapters,
      contextBuilder,
      stateStore,
      costTracker,
      gateway,
      labels: COMMITTEE_LABELS,
      discussions: company.project.repo
        ? createDiscussionsAdapter({
            token: requireEnv('GITHUB_TOKEN'),
            owner: requireEnv('GITHUB_OWNER'),
            repo: company.project.repo,
          })
        : undefined,
    })
  : createOrchestrator({
      company,
      taskAdapter: task,
      gitAdapter: github,
      llmAdapters,
      contextBuilder,
      stateStore,
      costTracker,
    })

const mode = isCommitteeMode ? 'committee' : 'dev'
console.log(`[floor-agents] starting (${mode} mode)`)
console.log(`  company:   ${company.name}`)
console.log(`  project:   ${company.project.name} (${company.project.repo})`)
console.log(`  agents:    ${company.agents.map(a => `${a.id} (${a.llm.provider})`).join(', ')}`)
console.log(`  task:      ${TASK_ADAPTER}`)
console.log(`  providers: ${[...llmAdapters.keys()].join(', ')}`)
console.log()

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  gateway?.stop()
  await orchestrator.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  gateway?.stop()
  await orchestrator.stop()
  process.exit(0)
})

await orchestrator.start()
