import { loadCompanyConfig, validateCompanyConfig, computeRequiredProviders, privateSourceDenials } from '@floor-agents/core'
import type { LLMAdapter } from '@floor-agents/core'
import { createAnthropicAdapter } from '@floor-agents/anthropic'
import { createOpenAIAdapter } from '@floor-agents/openai'
import { createLMStudioAdapter } from '@floor-agents/lmstudio'
import { createClaudeCodeAdapter } from '@floor-agents/claude-code'
import { createCursorAdapter } from '@floor-agents/cursor'
import { createAntigravityAdapter } from '@floor-agents/antigravity'
import { reviewerSandbox, withDenyRead } from '@floor-agents/sandbox'
import { createGeminiAdapter } from '@floor-agents/gemini'
import { createGitHubAdapter } from '@floor-agents/github'
import { createTaskAdapter } from '@floor-agents/task'
import { createContextBuilder } from '@floor-agents/context-builder'
import { createOrchestrator, createCommitteeOrchestrator, createCostTracker, createStateStore, executeTask, freshState, historyOf, historyText, lastAttempt, verifyPreservedAttempt, verifyRefusal, reseatRefusal, verifyFailedReport, sign, ENGINE_SIGNATURE, resolveAgent, createTelegramChannel, mirrorComments } from '@floor-agents/orchestrator'
import { createDiscussionsAdapter } from '@floor-agents/github'
import { createGateway } from '@floor-agents/gateway'
import { mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from './cli/args.ts'
import { doctorProject, initProject } from './cli/project.ts'
import { pipelinesFor, pipelinesLabel } from './cli/modes.ts'
import { loadProjectEnv, projectEnvPath } from './cli/env.ts'
import { startExternalVoters } from '../scripts/lib/bridges.ts'

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
  floor-agents run --issue <id> --retry Archive a failed attempt and run the issue again (its history is kept)
  floor-agents verify --issue <id>      Re-run the gate on a failed attempt's preserved tree and continue to the PR
  floor-agents review --issue <id>      Seat the committee again on a pull request its last review left undecided
  floor-agents status --issue <id>      Show an issue's attempts, gate runs and reviews
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

// Discover the manifest; project and prompt paths are resolved by the loader.
const CONFIG_PATH = args.config ?? process.env.CONFIG_PATH
  ?? (await Bun.file('.agents/agents.yaml').exists() ? '.agents/agents.yaml' : 'config/templates/default.yaml')
// The project's own secrets, beside its manifest: a Telegram chat per project,
// a token scoped to its repository. Loaded before anything reads the environment.
{
  const added = await loadProjectEnv(CONFIG_PATH)
  if (added.length) console.log(`[env] ${projectEnvPath(CONFIG_PATH)}: ${added.join(', ')}`)
}
const STATE_DIR = process.env.STATE_DIR ?? join(dirname(resolve(CONFIG_PATH)), 'runs')

// Trigger tags the committee watches (comma-separated).
const COMMITTEE_LABELS = (process.env.COMMITTEE_LABELS ?? 'committee,agents')
  .split(',').map(s => s.trim()).filter(Boolean)

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

// Where the tasks live: the manifest's `tasks.source`, else the environment, else
// GitHub issues for a run and Linear for a watch, as before the manifest could say.
const TASK_ADAPTER = company.tasks?.source ?? process.env.TASK_ADAPTER ?? (args.command === 'watch' ? 'linear' : 'github-issues')

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
// run through the native runner, in an implementer sandbox on a worktree. Either
// way the sandbox denies the private sources a provider is not trusted with.
if (requiredProviders.has('claude-code')) {
  const adapter = createClaudeCodeAdapter({
    cwd: company.project.root ?? process.cwd(),
    model: process.env.CLAUDE_CODE_MODEL,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'LSP'],
    sandbox: withDenyRead(reviewerSandbox('claude'), privateSourceDenials(company, 'claude-code')),
  })
  llmAdapters.set('claude-code', adapter)
}

if (requiredProviders.has('cursor')) {
  llmAdapters.set('cursor', createCursorAdapter({
    cwd: company.project.root ?? process.cwd(),
    sandbox: withDenyRead(reviewerSandbox('cursor'), privateSourceDenials(company, 'cursor')),
  }))
}

if (requiredProviders.has('antigravity')) {
  llmAdapters.set('antigravity', createAntigravityAdapter({
    cwd: company.project.root ?? process.cwd(),
    sandbox: withDenyRead(reviewerSandbox('antigravity'), privateSourceDenials(company, 'antigravity')),
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

// Create task adapter — driven by env var. A factory, because each adapter keeps
// its record of seen issues per instance: two watchers must not share one.
const createTask = () => {
  switch (TASK_ADAPTER) {
    case 'linear':
      return createTaskAdapter({
        type: 'linear',
        linear: {
          apiKey: requireEnv('LINEAR_API_KEY'),
          teamId: company.tasks?.linear?.team ?? requireEnv('LINEAR_TEAM_ID'),
          projectId: process.env.LINEAR_PROJECT_ID,
          ...(company.tasks?.linear?.project ? { projectName: company.tasks.linear.project } : {}),
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
          repo: company.tasks?.github?.repo ?? process.env.GITHUB_ISSUES_REPO ?? company.project.repo,
        },
      })
    default:
      throw new Error(`Unknown TASK_ADAPTER: ${TASK_ADAPTER}`)
  }
}
// The Telegram channel, when the environment carries a bot and a chat. Every
// comment a run posts on its issue is repeated there, so a phone shows the run
// without opening GitHub. Absent credentials simply mean no channel.
const telegram = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
  ? createTelegramChannel({
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      ...(process.env.TELEGRAM_ALLOW_FROM ? { allowFrom: process.env.TELEGRAM_ALLOW_FROM.split(',').map(s => s.trim()).filter(Boolean) } : {}),
      log: msg => console.log(`[telegram] ${msg}`),
    })
  : null

const withChannel = (adapter: ReturnType<typeof createTask>) =>
  telegram ? mirrorComments(adapter, telegram, { from: company.project.name || company.name, log: msg => console.log(`[telegram] ${msg}`) }) : adapter

const task = withChannel(createTask())

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

// Each role brings its own pipeline: implementers run development, voters run the
// committee, and a manifest holding both runs both. `run` always implements.
const pipelines = pipelinesFor(company.agents)
const hasExternalAgents = company.agents.some(a => a.external)

const stateStore = createStateStore(STATE_DIR)
const costTracker = createCostTracker()

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT ?? '3100', 10)
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN
const externalVoterOpts = {
  port: GATEWAY_PORT,
  repo: company.project.root ?? process.cwd(),
  log: (m: string) => console.log(`[bridges] ${m}`),
  manifest: company,
}

/** What `run` and `verify` hand the pipeline: one issue, then exit. */
const oneShotDeps = (): Parameters<typeof executeTask>[2] => ({
  company, taskAdapter: task, gitAdapter: github, contextBuilder, stateStore, costTracker,
  getAdapter: provider => {
    const adapter = llmAdapters.get(provider)
    if (!adapter) throw new Error(`No adapter for ${provider}`)
    return adapter
  },
  findReviewer: () => company.agents.find(a => a.capabilities.includes('review_pr') && !a.external),
  // A one-shot command never starts the long-lived watch gateway. The host
  // stands one up for the PR review (if any external voter needs a bridge) and
  // stops it with the bridges when the votes are in.
  externalVoters: { start: agents => startExternalVoters(agents, externalVoterOpts) },
})

if (args.command === 'verify') {
  // Take the last attempt's preserved tree forward without another agent turn.
  const issue = await task.getIssue(args.issue!)
  if (!issue) { console.error(`Issue not found: ${args.issue}`); process.exit(1) }
  const key = issue.key ?? issue.id
  const recorded = await stateStore.get(issue.id)
  const refusal = verifyRefusal(recorded, existsSync)
  if (refusal) { console.error(`Cannot verify ${key}: ${refusal}`); process.exit(1) }
  const agent = company.agents.find(a => a.id === recorded!.agentId)
  if (!agent) { console.error(`Cannot verify ${key}: agent "${recorded!.agentId}" is no longer in the manifest`); process.exit(1) }
  try {
    await task.removeLabel(issue.id, 'needs-human')
    const verified = await verifyPreservedAttempt(issue, agent, recorded!, {
      contextBuilder, stateStore, costTracker, project: company.project, guardrails: company.guardrails,
      // The engine took the tree forward, not the agent: its words carry the engine's signature.
      addComment: (id, text) => task.addComment(id, sign(text, ENGINE_SIGNATURE)),
      setLabel: (id, label) => task.setLabel(id, label),
    })
    // Published: the rest is the ordinary path — pull request, review, done.
    await executeTask(issue, agent, oneShotDeps(), verified)
    const state = await stateStore.get(issue.id)
    if (state?.step !== 'done') throw new Error(state?.error ?? `Task did not complete (${state?.step ?? 'no state'})`)
    console.log(`Ready for human review: ${state.prUrl}\nExecution state: ${STATE_DIR}`)
    process.exit(0)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(message)
    const after = await stateStore.get(issue.id)
    const attempt = after ? lastAttempt(after) : undefined
    // A tree that was taken up and failed again is reported; a run that got past
    // publication reported its own failure on the way.
    if (attempt && attempt.outcome !== 'published') {
      const failing = attempt.gates.at(-1)?.checks.find(c => c.exitCode !== 0 || c.timedOut)
      await task.addComment(issue.id, sign(verifyFailedReport(attempt.n, message, failing, key), ENGINE_SIGNATURE)).catch(() => {})
      await task.setLabel(issue.id, 'needs-human').catch(() => {})
    }
    process.exit(1)
  }
}

if (args.command === 'review') {
  // Seat the committee again on a pull request its last review left undecided.
  const issue = await task.getIssue(args.issue!)
  if (!issue) { console.error(`Issue not found: ${args.issue}`); process.exit(1) }
  const key = issue.key ?? issue.id
  const recorded = await stateStore.get(issue.id)
  const refusal = reseatRefusal(recorded)
  if (refusal) { console.error(`Cannot review ${key}: ${refusal}`); process.exit(1) }
  const agent = company.agents.find(a => a.id === recorded!.agentId)
  if (!agent) { console.error(`Cannot review ${key}: agent "${recorded!.agentId}" is no longer in the manifest`); process.exit(1) }
  try {
    // The pipeline is entered at its review step: it checks that the pull request
    // still carries the verified commit, seats the committee, and goes on from the
    // verdict as any run does — a revision on a rejection, done on an approval.
    await task.removeLabel(issue.id, 'needs-human')
    const reviewing = { ...recorded!, step: 'reviewing' as const, error: null, updatedAt: new Date().toISOString() }
    await stateStore.save(reviewing)
    await executeTask(issue, agent, oneShotDeps(), reviewing)
    const state = await stateStore.get(issue.id)
    if (state?.step !== 'done') throw new Error(state?.error ?? `Task did not complete (${state?.step ?? 'no state'})`)
    const last = state.reviews?.at(-1)
    console.log(`Review of ${key}: ${last?.outcome ?? 'not recorded'} — ${state.prUrl}`)
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

if (args.command === 'status') {
  // The history of one issue's runs: attempts, their gates, the reviews.
  const issue = await task.getIssue(args.issue!)
  if (!issue) { console.error(`Issue not found: ${args.issue}`); process.exit(1) }
  const recorded = await stateStore.get(issue.id)
  console.log(recorded
    ? `${issue.key ?? issue.id} — ${issue.title}\n${historyText(recorded, existsSync)}`
    : `${issue.key ?? issue.id} — ${issue.title}\nno run recorded in ${STATE_DIR}`)
  process.exit(0)
}

if (args.command === 'run') {
  try {
    const issue = await task.getIssue(args.issue!)
    if (!issue) throw new Error(`Issue not found: ${args.issue}`)
    const existing = await stateStore.get(issue.id)
    if (existing && args.retry) {
      // A failed attempt is kept, out of the way, and the issue is a task again.
      if (existing.step !== 'failed') throw new Error(`Issue is ${existing.step}, not failed; --retry only restarts a failed attempt.`)
      const archive = join(STATE_DIR, 'archive')
      await mkdir(archive, { recursive: true })
      await rename(join(STATE_DIR, `${issue.id}.json`), join(archive, `${issue.id}.${existing.updatedAt.replace(/[:.]/g, '-')}.json`))
      await task.removeLabel(issue.id, 'needs-human')
      console.log(`[orchestrator] retrying ${args.issue}: failed attempt archived (${existing.error ?? 'no error recorded'})`)
    } else if (existing) {
      throw new Error(`Issue already has execution state (${existing.step}). Pass --retry to archive a failed attempt and start over; run never overwrites one.`)
    }
    const agent = resolveAgent(issue, company.agents)
    if (!agent) throw new Error('No internal agent with write_code capability is configured')
    await executeTask(issue, agent, oneShotDeps(), freshState(issue.id, agent.id, args.retry ? historyOf(existing) : {}))
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
const gateway = hasExternalAgents
  ? createGateway({ port: GATEWAY_PORT, token: GATEWAY_TOKEN })
  : undefined

if (gateway) gateway.start()

const externalVoters = {
  start: (agents: Parameters<typeof startExternalVoters>[0]) =>
    startExternalVoters(agents, { ...externalVoterOpts, ...(gateway ? { gateway } : {}) }),
}

// Each pipeline watches its own labels. When both run, the committee gets its own
// task adapter so the two watchers do not overwrite each other's seen-issue record.
const orchestrators = [
  ...(pipelines.development
    ? [createOrchestrator({
        company,
        ...(company.tasks?.labels ? { labels: company.tasks.labels } : {}),
        taskAdapter: task,
        gitAdapter: github,
        llmAdapters,
        contextBuilder,
        stateStore,
        costTracker,
        gateway,
        externalVoters,
      })]
    : []),
  ...(pipelines.committee
    ? [createCommitteeOrchestrator({
        company,
        taskAdapter: pipelines.development ? withChannel(createTask()) : task,
        gitAdapter: github,
        llmAdapters,
        contextBuilder,
        stateStore,
        costTracker,
        gateway,
        externalVoters,
        labels: COMMITTEE_LABELS,
        discussions: company.project.repo
          ? createDiscussionsAdapter({
              token: requireEnv('GITHUB_TOKEN'),
              owner: requireEnv('GITHUB_OWNER'),
              repo: company.project.repo,
            })
          : undefined,
      })]
    : []),
]

console.log(`[floor-agents] starting (${pipelinesLabel(pipelines)} mode)`)
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
  await Promise.all(orchestrators.map(o => o.stop()))
  process.exit(0)
})

process.on('SIGTERM', async () => {
  gateway?.stop()
  await Promise.all(orchestrators.map(o => o.stop()))
  process.exit(0)
})

await Promise.all(orchestrators.map(o => o.start()))
