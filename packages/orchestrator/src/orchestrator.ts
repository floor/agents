import type {
  CompanyConfig,
  TaskAdapter,
  GitAdapter,
  LLMAdapter,
  LLMMessage,
  ContentBlock,
  Issue,
  ExecutionState,
  ExecutionStep,
  StateStore,
  AgentDefinition,
  ToolCall,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import { parseToolCallOutput } from './output-parser.ts'
import { validateAgentOutput } from './guardrails.ts'
import { resolveAgent } from './dispatcher.ts'
import type { CostTracker } from './cost-tracker.ts'

export type OrchestratorConfig = {
  readonly company: CompanyConfig
  readonly taskAdapter: TaskAdapter
  readonly gitAdapter: GitAdapter
  readonly llmAdapters: ReadonlyMap<string, LLMAdapter>
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
}

export type Orchestrator = {
  start(): Promise<void>
  stop(): Promise<void>
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

function makeState(issueId: string, agentId: string, overrides?: Partial<ExecutionState>): ExecutionState {
  const now = new Date().toISOString()
  return {
    issueId,
    agentId,
    step: 'pending',
    startedAt: now,
    branchName: null,
    commitSha: null,
    prUrl: null,
    llmResponse: null,
    parsedOutput: null,
    costUsd: 0,
    error: null,
    updatedAt: now,
    ...overrides,
  }
}

async function advanceState(
  state: ExecutionState,
  step: ExecutionStep,
  updates: Partial<ExecutionState>,
  store: StateStore,
): Promise<ExecutionState> {
  const next: ExecutionState = { ...state, step, ...updates, updatedAt: new Date().toISOString() }
  await store.save(next)
  return next
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

  async function runToolUseLoop(
    agent: AgentDefinition,
    systemPrompt: string,
    messages: LLMMessage[],
    tools: Parameters<ContextBuilder['build']> extends [infer P] ? Awaited<ReturnType<ContextBuilder['build']>>['tools'] : never,
  ): Promise<{ toolCalls: ToolCall[]; content: string; totalCost: number; totalInputTokens: number; totalOutputTokens: number }> {
    const llm = getLLMAdapter(agent.llm.provider)
    const allToolCalls: ToolCall[] = []
    let content = ''
    let totalCost = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    const conversation = [...messages]

    while (true) {
      const response = await llm.run({
        provider: agent.llm.provider,
        model: agent.llm.model,
        system: systemPrompt,
        messages: conversation,
        tools,
        maxTokens: agent.llm.maxTokens,
        temperature: agent.llm.temperature,
      })

      content += response.content
      totalCost += response.usage.cost
      totalInputTokens += response.usage.inputTokens
      totalOutputTokens += response.usage.outputTokens

      if (response.toolCalls.length > 0) {
        allToolCalls.push(...response.toolCalls)
      }

      if (response.stopReason !== 'tool_use') break

      // Build assistant message with tool_use blocks + tool_result acknowledgments
      const assistantBlocks: ContentBlock[] = []
      if (response.content) {
        assistantBlocks.push({ type: 'text', text: response.content })
      }
      for (const tc of response.toolCalls) {
        assistantBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })
      }

      conversation.push({ role: 'assistant', content: assistantBlocks })

      // Acknowledge tool calls
      const resultBlocks: ContentBlock[] = response.toolCalls.map(tc => ({
        type: 'tool_result' as const,
        tool_use_id: tc.id,
        content: 'ok',
      }))

      conversation.push({ role: 'user', content: resultBlocks })
    }

    return { toolCalls: allToolCalls, content, totalCost, totalInputTokens, totalOutputTokens }
  }

  async function executeTask(issue: Issue, agent: AgentDefinition, existingState?: ExecutionState) {
    let state = existingState ?? makeState(issue.id, agent.id)
    const { guardrails, costs } = company

    try {
      // Step: building_context
      if (state.step === 'pending' || state.step === 'building_context') {
        console.log(`[orchestrator] building context for "${issue.title}"`)
        state = await advanceState(state, 'building_context', {}, stateStore)

        await taskAdapter.addComment(issue.id, '🤖 Agent picking up this task...')
      }

      // Step: calling_llm
      if (state.step === 'building_context' || state.step === 'calling_llm') {
        state = await advanceState(state, 'calling_llm', {}, stateStore)

        // Check daily cost
        if (!costTracker.canStartNewTask(costs)) {
          throw new Error('Daily cost limit reached. Will resume tomorrow or when limit is increased.')
        }

        const ctx = await contextBuilder.build({
          agent,
          issue,
          project: company.project,
        })

        console.log(`[orchestrator] calling LLM (${agent.llm.model})...`)

        const result = await runToolUseLoop(
          agent,
          ctx.systemPrompt,
          [{ role: 'user', content: ctx.userMessage }],
          ctx.tools,
        )

        costTracker.recordCost(issue.id, result.totalCost)
        console.log(`[orchestrator] LLM: ${result.totalInputTokens} in, ${result.totalOutputTokens} out, $${result.totalCost.toFixed(4)}`)

        // Check task cost
        const costCheck = costTracker.checkTaskCost(issue.id, costs)
        if (!costCheck.ok) {
          throw new Error(costCheck.message)
        }
        if (costCheck.message) {
          await taskAdapter.addComment(issue.id, `⚠️ ${costCheck.message}`)
        }

        state = await advanceState(state, 'parsing_output', {
          llmResponse: result.content,
          costUsd: costTracker.getTaskCost(issue.id),
        }, stateStore)

        // Step: parsing_output
        const output = parseToolCallOutput({
          content: result.content,
          toolCalls: result.toolCalls,
          stopReason: 'end_turn',
          usage: { inputTokens: result.totalInputTokens, outputTokens: result.totalOutputTokens, cost: result.totalCost },
          provider: agent.llm.provider,
          model: agent.llm.model,
          durationMs: 0,
        })

        if (output.parseErrors.length > 0 && output.files.length === 0) {
          // Retry once
          console.log('[orchestrator] no files from tool calls, retrying...')
          const retry = await runToolUseLoop(
            agent,
            ctx.systemPrompt,
            [
              { role: 'user', content: ctx.userMessage },
              { role: 'assistant', content: result.content || 'I need to provide the implementation using tools.' },
              { role: 'user', content: 'Please provide your implementation using the write_file tool for each file you want to create or modify.' },
            ],
            ctx.tools,
          )

          costTracker.recordCost(issue.id, retry.totalCost)

          const retryOutput = parseToolCallOutput({
            content: retry.content,
            toolCalls: retry.toolCalls,
            stopReason: 'end_turn',
            usage: { inputTokens: retry.totalInputTokens, outputTokens: retry.totalOutputTokens, cost: retry.totalCost },
            provider: agent.llm.provider,
            model: agent.llm.model,
            durationMs: 0,
          })

          if (retryOutput.files.length === 0) {
            await taskAdapter.addComment(issue.id, '❌ Agent could not produce structured output after retry.')
            await taskAdapter.setLabel(issue.id, 'needs-human')
            state = await advanceState(state, 'failed', {
              error: 'No files produced after retry',
              parsedOutput: retryOutput,
            }, stateStore)
            return
          }

          state = await advanceState(state, 'validating_output', {
            parsedOutput: retryOutput,
          }, stateStore)
        } else {
          state = await advanceState(state, 'validating_output', {
            parsedOutput: output,
          }, stateStore)
        }
      }

      // Step: validating_output
      if (state.step === 'validating_output' && state.parsedOutput) {
        const violations = validateAgentOutput(state.parsedOutput, guardrails)

        if (violations.length > 0) {
          const details = violations.map(v => `- ${v.detail}`).join('\n')
          await taskAdapter.addComment(issue.id, `❌ Guardrail violations:\n${details}`)
          await taskAdapter.setLabel(issue.id, 'needs-human')
          state = await advanceState(state, 'failed', {
            error: `Guardrail violations: ${violations.length}`,
          }, stateStore)
          return
        }

        state = await advanceState(state, 'creating_branch', {}, stateStore)
      }

      // Step: creating_branch
      if (state.step === 'creating_branch') {
        const branchName = `agent/${slugify(issue.title)}`
        console.log(`[orchestrator] creating branch: ${branchName}`)

        await gitAdapter.createBranch(company.project.repo, branchName)
        state = await advanceState(state, 'committing_files', { branchName }, stateStore)
      }

      // Step: committing_files
      if (state.step === 'committing_files' && state.branchName && state.parsedOutput) {
        console.log(`[orchestrator] committing ${state.parsedOutput.files.length} files`)

        const sha = await gitAdapter.commitFiles(
          company.project.repo,
          state.branchName,
          state.parsedOutput.files.map(f => ({ path: f.path, content: f.content })),
          `${issue.title}\n\nAutomated by Floor Agents\nTask: ${issue.id}`,
        )

        console.log(`[orchestrator] committed: ${sha.slice(0, 8)}`)
        state = await advanceState(state, 'creating_pr', { commitSha: sha }, stateStore)
      }

      // Step: creating_pr
      if (state.step === 'creating_pr' && state.branchName && state.parsedOutput) {
        const pr = await gitAdapter.createPR(
          company.project.repo,
          state.branchName,
          issue.title,
          state.parsedOutput.prDescription || [
            'Automated PR by Floor Agents',
            '',
            `**Task:** ${issue.title}`,
            issue.body ? `\n${issue.body}` : '',
            '',
            `**Files changed:**`,
            ...state.parsedOutput.files.map(f => `- \`${f.path}\``),
            '',
            `**Model:** ${agent.llm.model}`,
            `**Cost:** $${state.costUsd.toFixed(4)}`,
          ].join('\n'),
        )

        console.log(`[orchestrator] PR created: ${pr.url}`)
        state = await advanceState(state, 'updating_issue', { prUrl: pr.url }, stateStore)
      }

      // Step: updating_issue
      if (state.step === 'updating_issue' && state.prUrl) {
        await taskAdapter.addComment(issue.id, `✅ PR created: ${state.prUrl}`)
        await taskAdapter.setStatus(issue.id, 'in_review')
        state = await advanceState(state, 'done', {}, stateStore)
        console.log(`[orchestrator] done: ${issue.title}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[orchestrator] error: ${message}`)

      state = await advanceState(state, 'failed', { error: message }, stateStore)

      try {
        await taskAdapter.addComment(issue.id, `❌ Agent error: ${message}`)
        await taskAdapter.setLabel(issue.id, 'needs-human')
      } catch {}
    }
  }

  return {
    async start() {
      console.log('[orchestrator] starting...')

      // Resume incomplete tasks
      const existing = await stateStore.list()
      const incomplete = existing.filter(s => s.step !== 'done' && s.step !== 'failed')

      if (incomplete.length > 0) {
        console.log(`[orchestrator] resuming ${incomplete.length} incomplete tasks`)
        for (const state of incomplete) {
          const issue = await taskAdapter.getIssue(state.issueId)
          if (!issue) continue
          const agent = company.agents.find(a => a.id === state.agentId)
          if (!agent) continue
          await executeTask(issue, agent, state)
        }
      }

      // Track known issue IDs to avoid reprocessing
      const knownIds = new Set(existing.map(s => s.issueId))

      console.log('[orchestrator] watching for tasks...\n')

      // Race the watch loop against the abort signal so stop() can break it
      const abortPromise = new Promise<void>((resolve) => {
        abortController.signal.addEventListener('abort', () => resolve(), { once: true })
      })

      const watchLoop = async () => {
        for await (const event of taskAdapter.watchIssues({ labels: ['agent'] })) {
          if (!running) break

          if (event.type === 'created' && event.issue.status !== 'done') {
            if (knownIds.has(event.issue.id)) {
              console.log(`[skip] already processed: ${event.issue.title}`)
              continue
            }

            if (!costTracker.canStartNewTask(company.costs)) {
              console.log('[skip] daily cost limit reached')
              await taskAdapter.addComment(
                event.issue.id,
                '⏸️ Daily cost limit reached. Will resume tomorrow or when limit is increased.',
              )
              continue
            }

            const agent = resolveAgent(event.issue, company.agents)
            if (!agent) {
              console.log(`[skip] no matching agent for: ${event.issue.title}`)
              continue
            }

            knownIds.add(event.issue.id)
            console.log(`\n[orchestrator] processing: ${event.issue.title} → ${agent.name}`)
            await executeTask(event.issue, agent)
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
