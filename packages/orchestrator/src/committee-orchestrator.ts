import type {
  CompanyConfig,
  TaskAdapter,
  GitAdapter,
  LLMAdapter,
  StateStore,
  AgentDefinition,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import type { CostTracker } from './cost-tracker.ts'
import type { DiscussionsAdapter } from '@floor-agents/github'
import { executeCommitteeReview, type CommitteePipelineDeps } from './committee-pipeline.ts'

export type CommitteeOrchestratorConfig = {
  readonly company: CompanyConfig
  readonly taskAdapter: TaskAdapter
  readonly gitAdapter: GitAdapter
  readonly llmAdapters: ReadonlyMap<string, LLMAdapter>
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly discussions?: DiscussionsAdapter
  readonly label?: string
  readonly repoConfigPath?: string
}

export type CommitteeOrchestrator = {
  start(): Promise<void>
  stop(): Promise<void>
}

const DEFAULT_REPO_CONFIG_PATH = '.agents/committee.yaml'

export function createCommitteeOrchestrator(config: CommitteeOrchestratorConfig): CommitteeOrchestrator {
  const {
    company, taskAdapter, gitAdapter, llmAdapters, contextBuilder,
    stateStore, costTracker, discussions,
  } = config

  const watchLabel = config.label ?? 'committee'
  const repoConfigPath = config.repoConfigPath ?? DEFAULT_REPO_CONFIG_PATH
  let running = true
  const abortController = new AbortController()
  const processedIds = new Set<string>()

  function getLLMAdapter(provider: string): LLMAdapter {
    const adapter = llmAdapters.get(provider)
    if (!adapter) throw new Error(`No LLM adapter for provider: ${provider}`)
    return adapter
  }

  function getCommitteeAgents(): AgentDefinition[] {
    return company.agents.filter(a => a.capabilities.includes('vote'))
  }

  async function loadRepoContext(): Promise<string | undefined> {
    try {
      const file = await gitAdapter.getFile(company.project.repo, repoConfigPath)
      if (file) {
        console.log(`[committee] loaded repo config from ${repoConfigPath}`)
        return file.content
      }
    } catch {
      // Repo config is optional
    }
    return undefined
  }

  return {
    async start() {
      const agents = getCommitteeAgents()
      console.log(`[committee] starting with ${agents.length} agents: ${agents.map(a => a.id).join(', ')}`)
      console.log(`[committee] watching for label: "${watchLabel}"`)
      console.log(`[committee] repo config: ${repoConfigPath}`)
      if (discussions) {
        console.log('[committee] GitHub Discussions sync: enabled')
      }

      const abortPromise = new Promise<void>((resolve) => {
        abortController.signal.addEventListener('abort', () => resolve(), { once: true })
      })

      const watchLoop = async () => {
        for await (const event of taskAdapter.watchIssues({ labels: [watchLabel] })) {
          if (!running) break

          if (event.type === 'created' && event.issue.status !== 'done') {
            if (processedIds.has(event.issue.id)) {
              console.log(`[committee] skip: already processed "${event.issue.title}"`)
              continue
            }

            if (!costTracker.canStartNewTask(company.costs)) {
              console.log('[committee] skip: daily cost limit reached')
              await taskAdapter.addComment(
                event.issue.id,
                '⏸️ **Daily cost limit reached.** Committee review deferred.',
              )
              continue
            }

            processedIds.add(event.issue.id)
            console.log(`\n[committee] new proposal: "${event.issue.title}"`)

            try {
              const repoContext = await loadRepoContext()

              const pipelineDeps: CommitteePipelineDeps = {
                company,
                taskAdapter,
                contextBuilder,
                stateStore,
                costTracker,
                getAdapter: getLLMAdapter,
                discussions,
                repoContext,
              }

              await executeCommitteeReview(event.issue, agents, pipelineDeps)
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              console.error(`[committee] review failed: ${message}`)
              await taskAdapter.addComment(
                event.issue.id,
                `❌ **Committee review error**\n\n\`\`\`\n${message}\n\`\`\``,
              )
            }
          }
        }
      }

      await Promise.race([watchLoop(), abortPromise])
    },

    async stop() {
      console.log('[committee] stopping...')
      running = false
      abortController.abort()
    },
  }
}
