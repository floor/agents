import { loadCompanyConfig, validateCompanyConfig, computeRequiredProviders } from '@floor-agents/core'
import type { LLMAdapter } from '@floor-agents/core'
import { createAnthropicAdapter } from '@floor-agents/anthropic'
import { createOpenAIAdapter } from '@floor-agents/openai'
import { createLMStudioAdapter } from '@floor-agents/lmstudio'
import { createClaudeCodeAdapter } from '@floor-agents/claude-code'
import { createCursorAdapter } from '@floor-agents/cursor'
import { reviewerSandbox } from '@floor-agents/sandbox'
import { createGeminiAdapter } from '@floor-agents/gemini'
import { createGitHubAdapter } from '@floor-agents/github'
import { createTaskAdapter } from '@floor-agents/task'
import { createContextBuilder } from '@floor-agents/context-builder'
import { createOrchestrator, createCommitteeOrchestrator, createCostTracker, createStateStore, executeTask, resolveAgent } from '@floor-agents/orchestrator'
import { createDiscussionsAdapter } from '@floor-agents/github'
import { createGateway } from '@floor-agents/gateway'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from './cli/args.ts'
import { doctorProject, initProject } from './cli/project.ts'

// ── CLI flags (handle before any startup work) ───────────────────
const VERSION = (
  await Bun.file(new URL('../package.json', import.meta.url)).json().catch(() => ({ version: '0.0.0' }))
).version as string

const args = (() => {
  try { return parseArgs(Bun.argv.slice(2)) }
  catch (err) { console.error(String(err)); process.exit(1) }
})()

if (args.command === 'version') {
  console.log(VERSION)
  process.exit(0)
}
if (args.command === 'help') {
  console.log(`floor-agents v${VERSION}

Usage:
  floor-agents init                     Create .agents/agents.yaml and a developer prompt
  floor-agents doctor                   Check project setup without running an agent
  floor-agents run --issue <id>         Implement one issue and exit (defaults to GitHub Issues)
  floor-agents [watch]                  Watch the configured task source (defaults to Linear)
  floor-agents --config <path>          Select a manifest (also CONFIG_PATH)
  floor-agents --version

Configuration discovery: --config, CONFIG_PATH, .agents/agents.yaml, then the local dev template.
Credentials: GITHUB_TOKEN plus keys for your task source/providers. Set TASK_ADAPTER to override
linear | things | github-issues. GITHUB_OWNER overrides project.owner.
Verified execution requires project.root, project.baseBranch and project.verification.
Logs and check results are stored in STATE_DIR (default: runs/ beside the manifest).
Requires Bun. Docs: https://github.com/floor/agents`)
  process.exit(0)
}
if (args.command === 'init') {
  try { await initProject(args.config ?? process.env.CONFIG_PATH ?? '.agents/agents.yaml') }
  catch (err) { console.error(String(err)); process.exit(1) }
  process.exit(0)
}

// Environment
const TASK_ADAPTER = process.env.TASK_ADAPTER ?? (args.command === 'watch' ? 'linear' : 'github-issues')
// Trigger tags the committee watches (comma-separated).
const COMMITTEE_LABELS = (process.env.COMMITTEE_LABELS ?? 'committee,agents')
  .split(',').map(s => s.trim()).filter(Boolean)

// Discover the manifest; project and prompt paths are resolved by the loader.
const CONFIG_PATH = args.config ?? process.env.CONFIG_PATH
  ?? (await Bun.file('.agents/agents.yaml').exists() ? '.agents/agents.yaml' : 'config/templates/default.yaml')
const STATE_DIR = process.env.STATE_DIR ?? join(dirname(resolve(CONFIG_PATH)), 'runs')

// Load and validate config
const company = await loadCompanyConfig(CONFIG_PATH).catch(err => {
  console.error(`${String(err)}\nRun floor-agents init or pass --config <path>.`)
  process.exit(1)
})
const errors = validateCompanyConfig(company)

if (errors.length > 0) {
  console.error('Config validation errors:')
  for (const err of errors) console.error(`  - ${err}`)
  process.exit(1)
}

if (args.command === 'run' && company.agents.some(a => a.capabilities.includes('vote'))) {
  console.error('run implements an issue. Use a developer config without vote agents; committee review remains available through watch.')
  process.exit(1)
}
if (args.command === 'doctor' || args.command === 'run' || company.project.verification) {
  const diagnostics = await doctorProject(company, TASK_ADAPTER)
  for (const d of diagnostics) console.log(`${d.ok ? 'PASS' : 'FAIL'} ${d.name}: ${d.detail}`)
  if (diagnostics.some(d => !d.ok)) process.exit(1)
  if (args.command === 'doctor') process.exit(0)
}

// Determine which LLM providers are needed from agent definitions.
// External agents (Codex, Antigravity) run via the gateway, not an in-process
// LLM adapter, so they don't require their provider's API key.
const requiredProviders = computeRequiredProviders(company.agents)

function requireEnv(name: string): string {
  const value = process.env[name] ?? (name === 'GITHUB_OWNER' ? company.project.owner : undefined)
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

// In-process CLI adapters serve agents that read and decide — committee voters,
// the PM — so they run in a reviewer sandbox. Implementers do not use them: they
// run through the native runner, in an implementer sandbox on a worktree.
if (requiredProviders.has('claude-code')) {
  const adapter = createClaudeCodeAdapter({
    cwd: company.project.root ?? process.cwd(),
    model: process.env.CLAUDE_CODE_MODEL,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'LSP'],
    sandbox: reviewerSandbox('claude'),
  })
  llmAdapters.set('claude-code', adapter)
}

if (requiredProviders.has('cursor')) {
  llmAdapters.set('cursor', createCursorAdapter({
    cwd: company.project.root ?? process.cwd(),
    sandbox: reviewerSandbox('cursor'),
  }))
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
          repo: process.env.GITHUB_ISSUES_REPO ?? company.project.repo,
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

if (args.command === 'run') {
  try {
    const issue = await task.getIssue(args.issue!)
    if (!issue) throw new Error(`Issue not found: ${args.issue}`)
    const existing = await stateStore.get(issue.id)
    if (existing) throw new Error(`Issue already has execution state (${existing.step}). Inspect ${STATE_DIR} before retrying; run never overwrites an existing attempt.`)
    const agent = resolveAgent(issue, company.agents)
    if (!agent) throw new Error('No internal agent with write_code capability is configured')
    await executeTask(issue, agent, {
      company, taskAdapter: task, gitAdapter: github, contextBuilder, stateStore, costTracker,
      getAdapter: provider => {
        const adapter = llmAdapters.get(provider)
        if (!adapter) throw new Error(`No adapter for ${provider}`)
        return adapter
      },
      findReviewer: () => company.agents.find(a => a.capabilities.includes('review_pr') && !a.external),
    })
    const state = await stateStore.get(issue.id)
    if (state?.step !== 'done') throw new Error(state?.error ?? `Task did not complete (${state?.step ?? 'no state'})`)
    console.log(`Ready for human review: ${state.prUrl}\nExecution state: ${STATE_DIR}`)
    process.exit(0)
  } catch (err) {
    console.error(String(err))
    process.exit(1)
  }
}

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
