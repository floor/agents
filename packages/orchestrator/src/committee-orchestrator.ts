import type {
  CompanyConfig,
  TaskAdapter,
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
  readonly llmAdapters: ReadonlyMap<string, LLMAdapter>
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly discussions?: DiscussionsAdapter
  readonly label?: string
}

export type CommitteeOrchestrator = {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createCommitteeOrchestrator(config: CommitteeOrchestratorConfig): CommitteeOrchestrator {
  const {
    company, taskAdapter, llmAdapters, contextBuilder,
    stateStore, costTracker, discussions,
  } = config

  const watchLabel = config.label ?? 'committee'
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

  const pipelineDeps: CommitteePipelineDeps = {
    company,
    taskAdapter,
    contextBuilder,
    stateStore,
    costTracker,
    getAdapter: getLLMAdapter,
    discussions,
  }

  return {
    async start() {
      const agents = getCommitteeAgents()
      console.log(`[committee] starting with ${agents.length} agents: ${agents.map(a => a.id).join(', ')}`)
      console.log(`[committee] watching for label: "${watchLabel}"`)
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
            console.log(`\n[committee] new RFC: "${event.issue.title}"`)

            try {
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
