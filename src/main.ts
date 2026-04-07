import { loadCompanyConfig, validateCompanyConfig } from '@floor-agents/core'
import type { LLMAdapter } from '@floor-agents/core'
import { createAnthropicAdapter } from '@floor-agents/anthropic'
import { createOpenAIAdapter } from '@floor-agents/openai'
import { createLMStudioAdapter } from '@floor-agents/lmstudio'
import { createClaudeCodeAdapter } from '@floor-agents/claude-code'
import { createGeminiAdapter } from '@floor-agents/gemini'
import { createGitHubAdapter } from '@floor-agents/github'
import { createTaskAdapter } from '@floor-agents/task'
import { createContextBuilder } from '@floor-agents/context-builder'
import { createOrchestrator, createCostTracker, createStateStore } from '@floor-agents/orchestrator'
import { mkdir } from 'node:fs/promises'

// Environment
const CONFIG_PATH = process.env.CONFIG_PATH
const STATE_DIR = process.env.STATE_DIR ?? './data/executions'
const TASK_ADAPTER = process.env.TASK_ADAPTER ?? 'linear'

// Load and validate config
const company = await loadCompanyConfig(CONFIG_PATH)
const errors = validateCompanyConfig(company)

if (errors.length > 0) {
  console.error('Config validation errors:')
  for (const err of errors) console.error(`  - ${err}`)
  process.exit(1)
}

// Determine which LLM providers are needed from agent definitions
const requiredProviders = new Set(company.agents.map(a => a.llm.provider))

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

// Create orchestrator
const orchestrator = createOrchestrator({
  company,
  taskAdapter: task,
  gitAdapter: github,
  llmAdapters,
  contextBuilder,
  stateStore: createStateStore(STATE_DIR),
  costTracker: createCostTracker(),
})

console.log(`[floor-agents] starting`)
console.log(`  company:   ${company.name}`)
console.log(`  project:   ${company.project.name} (${company.project.repo})`)
console.log(`  agents:    ${company.agents.map(a => `${a.id} (${a.llm.provider})`).join(', ')}`)
console.log(`  task:      ${TASK_ADAPTER}`)
console.log(`  providers: ${[...llmAdapters.keys()].join(', ')}`)
console.log()

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  await orchestrator.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await orchestrator.stop()
  process.exit(0)
})

await orchestrator.start()
