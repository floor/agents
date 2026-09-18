import type {
  CompanyConfig,
  TaskAdapter,
  GitAdapter,
  LLMAdapter,
  StateStore,
  AgentDefinition,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import type { Gateway } from '@floor-agents/gateway'
import { resolveAgent } from './dispatcher.ts'
import { executeTask } from './pipeline.ts'
import { closeInterrupted, processTable } from './lifecycle.ts'
import { sign, ENGINE_SIGNATURE } from './comment-signature.ts'
import type { CostTracker } from './cost-tracker.ts'
import { committeePrReviewEnabled, committeeVoters } from './committee-pr-review.ts'
import type { ExternalVoterHost } from './committee-pipeline.ts'

export type OrchestratorConfig = {
  readonly company: CompanyConfig
  readonly taskAdapter: TaskAdapter
  readonly gitAdapter: GitAdapter
  readonly llmAdapters: ReadonlyMap<string, LLMAdapter>
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  /** Labels that hand an issue to the implementer. The manifest's `tasks.labels`; default `agent`. */
  readonly labels?: readonly string[]
  /** Shared with committee PR review so external voters can take part. */
  readonly gateway?: Gateway
  /** Starts CLI bridges for external voters when a PR is reviewed. */
  readonly externalVoters?: ExternalVoterHost
}

export type Orchestrator = {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createOrchestrator(config: OrchestratorConfig): Orchestrator {
  const { company, taskAdapter, gitAdapter, llmAdapters, contextBuilder, stateStore, costTracker } = config
  let running = true
  const abortController = new AbortController()

  function getLLMAdapter(provider: string): LLMAdapter {
    const adapter = llmAdapters.get(provider)
    if (!adapter) throw new Error(`No LLM adapter for provider: ${provider}`)
    return adapter
  }

  function findAgent(id: string): AgentDefinition | undefined {
    return company.agents.find(a => a.id === id)
  }

  function findReviewer(): AgentDefinition | undefined {
    return company.agents.find(a => a.capabilities.includes('review_pr') && !a.external)
  }

  const pipelineDeps = {
    company,
    taskAdapter,
    gitAdapter,
    contextBuilder,
    stateStore,
    costTracker,
    getAdapter: getLLMAdapter,
    findReviewer,
    ...(config.gateway ? { gateway: config.gateway } : {}),
    ...(config.externalVoters ? { externalVoters: config.externalVoters } : {}),
  }

  return {
    async start() {
      console.log('[orchestrator] starting...')

      if (committeePrReviewEnabled(company)) {
        const voters = committeeVoters(company.agents)
        console.log(`[orchestrator] committee PR review: ${voters.map(a => a.name).join(', ')}`)
      } else {
        const reviewer = findReviewer()
        if (reviewer) {
          console.log(`[orchestrator] team mode: dev agents + ${reviewer.name} (${reviewer.llm.provider}/${reviewer.llm.model})`)
        } else {
          console.log('[orchestrator] solo mode: no reviewer configured')
        }
      }

      // Resume incomplete tasks
      const existing = await stateStore.list()
      const incomplete = existing.filter(s => s.step !== 'done' && s.step !== 'failed')

      if (incomplete.length > 0) {
        console.log(`[orchestrator] resuming ${incomplete.length} incomplete tasks`)
        for (const recorded of incomplete) {
          const issue = await taskAdapter.getIssue(recorded.issueId)
          if (!issue) continue
          const agent = findAgent(recorded.agentId)
          if (!agent) continue
          // A turn still marked running has nobody running it: a crash or a kill left
          // it open. It is closed, its agent ended if it somehow survived, and the
          // issue is told — then the task goes on with a new turn.
          const { state, interrupted } = await closeInterrupted(recorded, processTable)
          if (interrupted) {
            await stateStore.save(state)
            console.log(`[orchestrator] attempt ${interrupted.n} of ${issue.key ?? issue.id} was left open${interrupted.killed ? '; its agent was still running and was ended' : ''}`)
            await taskAdapter.addComment(issue.id, sign([
              `🔁 **The engine restarted.** Attempt ${interrupted.n} was interrupted${interrupted.killed ? ' — its agent was still running and has been ended' : ''}; a new turn starts now.`,
              interrupted.worktreePath ? `> Its tree was kept: \`${interrupted.worktreePath}\`` : '',
            ].filter(Boolean).join('\n'), ENGINE_SIGNATURE)).catch(() => {})
          }
          await executeTask(issue, agent, pipelineDeps, state)
        }
      }

      const knownIds = new Set(existing.map(s => s.issueId))

      console.log('[orchestrator] watching for tasks...\n')

      const abortPromise = new Promise<void>((resolve) => {
        abortController.signal.addEventListener('abort', () => resolve(), { once: true })
      })

      const watchLoop = async () => {
        for await (const event of taskAdapter.watchIssues({ labels: [...(config.labels ?? ['agent'])] })) {
          if (!running) break

          if (event.type === 'created' && event.issue.status !== 'done') {
            if (knownIds.has(event.issue.id)) {
              console.log(`[skip] already processed: ${event.issue.title}`)
              continue
            }

            if (!costTracker.canStartNewTask(company.costs)) {
              console.log('[skip] daily cost limit reached')
              await taskAdapter.addComment(event.issue.id, '⏸️ **Daily cost limit reached.** Will resume tomorrow or when limit is increased.')
              continue
            }

            const agent = resolveAgent(event.issue, company.agents)
            if (!agent) {
              console.log(`[skip] no matching agent for: ${event.issue.title}`)
              continue
            }

            knownIds.add(event.issue.id)
            console.log(`\n[orchestrator] processing: ${event.issue.title} → ${agent.name}`)
            await executeTask(event.issue, agent, pipelineDeps)
          }
        }
      }

      await Promise.race([watchLoop(), abortPromise])
    },

    async stop() {
      console.log('[orchestrator] stopping...')
      running = false
      abortController.abort()
    },
  }
}
