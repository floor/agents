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
  ToolDefinition,
  ReviewVerdict,
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

const MAX_REVIEW_CYCLES = 3

const REVIEW_TOOLS: ToolDefinition[] = [
  {
    name: 'review_verdict',
    description: 'Submit your review verdict. Call exactly once.',
    inputSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          enum: ['approve', 'request_changes'],
          description: 'approve if the code is ready to merge, request_changes if it needs work',
        },
        comments: {
          type: 'string',
          description: 'Review comments. If requesting changes, be specific about what needs to change and why.',
        },
      },
      required: ['decision', 'comments'],
    },
  },
]

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
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
    prId: null,
    llmResponse: null,
    parsedOutput: null,
    reviewVerdict: null,
    reviewCycle: 0,
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

  // ── Helpers ───────────────────────────────────────────────────────

  function getLLMAdapter(provider: string): LLMAdapter {
    const adapter = llmAdapters.get(provider)
    if (!adapter) throw new Error(`No LLM adapter for provider: ${provider}`)
    return adapter
  }

  function findAgent(id: string): AgentDefinition | undefined {
    return company.agents.find(a => a.id === id)
  }

  function findReviewer(): AgentDefinition | undefined {
    return company.agents.find(a => a.capabilities.includes('review_pr'))
  }

  async function comment(issueId: string, text: string) {
    await taskAdapter.addComment(issueId, text)
  }

  // ── Tool use conversation loop ────────────────────────────────────

  async function runToolUseLoop(
    agent: AgentDefinition,
    systemPrompt: string,
    messages: LLMMessage[],
    tools: readonly ToolDefinition[],
  ): Promise<{ toolCalls: ToolCall[]; content: string; totalCost: number; totalInputTokens: number; totalOutputTokens: number; durationMs: number }> {
    const llm = getLLMAdapter(agent.llm.provider)
    const allToolCalls: ToolCall[] = []
    let content = ''
    let totalCost = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalDurationMs = 0
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
      totalDurationMs += response.durationMs

      if (response.toolCalls.length > 0) {
        allToolCalls.push(...response.toolCalls)
      }

      if (response.stopReason !== 'tool_use') break

      const assistantBlocks: ContentBlock[] = []
      if (response.content) {
        assistantBlocks.push({ type: 'text', text: response.content })
      }
      for (const tc of response.toolCalls) {
        assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      conversation.push({ role: 'assistant', content: assistantBlocks })

      const resultBlocks: ContentBlock[] = response.toolCalls.map(tc => ({
        type: 'tool_result' as const,
        tool_use_id: tc.id,
        content: 'ok',
      }))
      conversation.push({ role: 'user', content: resultBlocks })
    }

    return { toolCalls: allToolCalls, content, totalCost, totalInputTokens, totalOutputTokens, durationMs: totalDurationMs }
  }

  // ── Dev agent ─────────────────────────────────────────────────────

  async function runDevAgent(
    issue: Issue,
    agent: AgentDefinition,
    state: ExecutionState,
    reviewComments?: string,
  ): Promise<ExecutionState> {
    state = await advanceState(state, 'calling_llm', {}, stateStore)

    if (!costTracker.canStartNewTask(company.costs)) {
      throw new Error('Daily cost limit reached.')
    }

    const ctx = await contextBuilder.build({
      agent,
      issue,
      project: company.project,
      reviewComments,
    })

    const isRevision = !!reviewComments
    console.log(`[${agent.id}] calling LLM (${agent.llm.model})...`)

    await comment(issue.id, [
      isRevision
        ? `⏳ **${agent.name}** is addressing review feedback...`
        : `⏳ **${agent.name}** is writing code...`,
      `> Model: \`${agent.llm.model}\` via ${agent.llm.provider}`,
      `> Context: ${ctx.estimatedTokens} tokens`,
    ].join('\n'))

    const result = await runToolUseLoop(agent, ctx.systemPrompt, [{ role: 'user', content: ctx.userMessage }], ctx.tools)

    costTracker.recordCost(issue.id, result.totalCost)
    console.log(`[${agent.id}] LLM: ${result.totalInputTokens} in, ${result.totalOutputTokens} out, $${result.totalCost.toFixed(4)}, ${formatDuration(result.durationMs)}`)

    const costCheck = costTracker.checkTaskCost(issue.id, company.costs)
    if (!costCheck.ok) throw new Error(costCheck.message)
    if (costCheck.message) {
      await comment(issue.id, `⚠️ ${costCheck.message}`)
    }

    state = await advanceState(state, 'parsing_output', {
      llmResponse: result.content,
      costUsd: costTracker.getTaskCost(issue.id),
    }, stateStore)

    const output = parseToolCallOutput({
      content: result.content,
      toolCalls: result.toolCalls,
      stopReason: 'end_turn',
      usage: { inputTokens: result.totalInputTokens, outputTokens: result.totalOutputTokens, cost: result.totalCost },
      provider: agent.llm.provider,
      model: agent.llm.model,
      durationMs: result.durationMs,
    })

    if (output.parseErrors.length > 0 && output.files.length === 0) {
      console.log(`[${agent.id}] no files from tool calls, retrying...`)
      await comment(issue.id, `🔄 **${agent.name}** produced no files. Retrying...`)

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
        durationMs: retry.durationMs,
      })

      if (retryOutput.files.length === 0) {
        await comment(issue.id, `❌ **${agent.name}** could not produce structured output after retry.`)
        await taskAdapter.setLabel(issue.id, 'needs-human')
        return advanceState(state, 'failed', { error: 'No files produced after retry', parsedOutput: retryOutput }, stateStore)
      }

      return advanceState(state, 'validating_output', { parsedOutput: retryOutput }, stateStore)
    }

    // Report what was produced
    const totalSize = output.files.reduce((sum, f) => sum + new TextEncoder().encode(f.content).length, 0)
    await comment(issue.id, [
      `✅ **${agent.name}** produced ${output.files.length} file${output.files.length === 1 ? '' : 's'}:`,
      ...output.files.map(f => `- \`${f.path}\``),
      '',
      `> ${formatBytes(totalSize)} total | ${formatDuration(result.durationMs)} | $${result.totalCost.toFixed(4)}`,
    ].join('\n'))

    return advanceState(state, 'validating_output', { parsedOutput: output }, stateStore)
  }

  // ── Review agent ──────────────────────────────────────────────────

  async function runReviewAgent(
    issue: Issue,
    reviewer: AgentDefinition,
    state: ExecutionState,
  ): Promise<ExecutionState> {
    state = await advanceState(state, 'reviewing', {}, stateStore)

    const diff = await gitAdapter.getPRDiff(company.project.repo, state.prId!)
    console.log(`[${reviewer.id}] reviewing PR (${diff.length} chars of diff)...`)

    await comment(issue.id, [
      `🔎 **${reviewer.name}** is reviewing the PR...`,
      `> Model: \`${reviewer.llm.model}\` via ${reviewer.llm.provider}`,
      `> Review cycle: ${state.reviewCycle + 1}/${MAX_REVIEW_CYCLES}`,
    ].join('\n'))

    let rolePrompt = ''
    try {
      const file = Bun.file(reviewer.promptTemplate)
      if (await file.exists()) rolePrompt = await file.text()
    } catch {}
    if (!rolePrompt) rolePrompt = 'You are a code reviewer.'

    const systemPrompt = [
      rolePrompt,
      '',
      '## Project',
      `Project: ${company.project.name}`,
      `Language: ${company.project.language}`,
      '',
      '## Output',
      'Use the `review_verdict` tool to submit your review.',
      'Set decision to "approve" if the code is ready, or "request_changes" if it needs work.',
      'In comments, be specific about what needs to change.',
    ].join('\n')

    const userMessage = [
      '## Task',
      `**${issue.title}**`,
      issue.body || '',
      '',
      `## PR Diff (review cycle ${state.reviewCycle + 1})`,
      '```diff',
      diff,
      '```',
      '',
      'Please review this PR.',
    ].join('\n')

    const result = await runToolUseLoop(reviewer, systemPrompt, [{ role: 'user', content: userMessage }], REVIEW_TOOLS)
    costTracker.recordCost(issue.id, result.totalCost)
    console.log(`[${reviewer.id}] LLM: ${result.totalInputTokens} in, ${result.totalOutputTokens} out, $${result.totalCost.toFixed(4)}`)

    const verdictCall = result.toolCalls.find(tc => tc.name === 'review_verdict')
    const verdict: ReviewVerdict = verdictCall
      ? { decision: verdictCall.input.decision as 'approve' | 'request_changes', comments: verdictCall.input.comments as string }
      : { decision: 'approve', comments: result.content || 'No specific feedback.' }

    console.log(`[${reviewer.id}] verdict: ${verdict.decision}`)

    // Post review as PR comment
    await gitAdapter.addPRComment(
      company.project.repo,
      state.prId!,
      [
        `## ${reviewer.name} Review (cycle ${state.reviewCycle + 1})`,
        '',
        `**Verdict:** ${verdict.decision === 'approve' ? '✅ Approved' : '🔄 Changes Requested'}`,
        '',
        verdict.comments,
        '',
        `*Model: ${reviewer.llm.model} | Cost: $${result.totalCost.toFixed(4)} | ${formatDuration(result.durationMs)}*`,
      ].join('\n'),
    )

    // Post verdict summary to Linear
    if (verdict.decision === 'approve') {
      await comment(issue.id, [
        `✅ **${reviewer.name}** approved the PR`,
        '',
        `> ${verdict.comments.length > 200 ? verdict.comments.slice(0, 200) + '...' : verdict.comments}`,
      ].join('\n'))
    } else {
      await comment(issue.id, [
        `🔄 **${reviewer.name}** requested changes (cycle ${state.reviewCycle + 1}/${MAX_REVIEW_CYCLES})`,
        '',
        `> ${verdict.comments.length > 300 ? verdict.comments.slice(0, 300) + '...' : verdict.comments}`,
      ].join('\n'))
    }

    return advanceState(state, verdict.decision === 'approve' ? 'updating_issue' : 'revision', {
      reviewVerdict: verdict,
      reviewCycle: state.reviewCycle + 1,
      costUsd: costTracker.getTaskCost(issue.id),
    }, stateStore)
  }

  // ── Main task pipeline ────────────────────────────────────────────

  async function executeTask(issue: Issue, devAgent: AgentDefinition, existingState?: ExecutionState) {
    let state = existingState ?? makeState(issue.id, devAgent.id)
    const { guardrails } = company
    const reviewer = findReviewer()
    const taskStart = performance.now()

    try {
      // Step: pending / building_context
      if (state.step === 'pending' || state.step === 'building_context') {
        console.log(`[orchestrator] building context for "${issue.title}"`)
        state = await advanceState(state, 'building_context', {}, stateStore)

        const teamInfo = reviewer
          ? `**${reviewer.name}** (\`${reviewer.llm.model}\`) will review.`
          : 'No reviewer configured.'

        await comment(issue.id, [
          `🤖 **${devAgent.name}** is picking up this task`,
          '',
          `**Team:**`,
          `- Developer: **${devAgent.name}** (\`${devAgent.llm.model}\` via ${devAgent.llm.provider})`,
          reviewer ? `- Reviewer: **${reviewer.name}** (\`${reviewer.llm.model}\` via ${reviewer.llm.provider})` : '',
          '',
          `**Pipeline:** code → guardrails → branch → PR${reviewer ? ' → review' : ''}`,
        ].filter(Boolean).join('\n'))
      }

      // Step: dev agent writes code
      if (state.step === 'building_context' || state.step === 'calling_llm' || state.step === 'parsing_output') {
        state = await runDevAgent(issue, devAgent, state)
      }

      // Step: guardrails
      if (state.step === 'validating_output' && state.parsedOutput) {
        const violations = validateAgentOutput(state.parsedOutput, guardrails)

        if (violations.length > 0) {
          const details = violations.map(v => `- ${v.detail}`).join('\n')
          await comment(issue.id, `❌ **Guardrail violations** — PR will not be created:\n${details}`)
          await taskAdapter.setLabel(issue.id, 'needs-human')
          state = await advanceState(state, 'failed', { error: `Guardrail violations: ${violations.length}` }, stateStore)
          return
        }

        await comment(issue.id, `🔍 **Guardrails passed** — ${state.parsedOutput.files.length} files validated`)
        state = await advanceState(state, 'creating_branch', {}, stateStore)
      }

      // Step: create branch
      if (state.step === 'creating_branch') {
        const branchName = `agent/${slugify(issue.title)}`
        console.log(`[orchestrator] creating branch: ${branchName}`)
        await gitAdapter.createBranch(company.project.repo, branchName)
        state = await advanceState(state, 'committing_files', { branchName }, stateStore)
      }

      // Step: commit files
      if (state.step === 'committing_files' && state.branchName && state.parsedOutput) {
        console.log(`[orchestrator] committing ${state.parsedOutput.files.length} files`)
        const sha = await gitAdapter.commitFiles(
          company.project.repo,
          state.branchName,
          state.parsedOutput.files.map(f => ({ path: f.path, content: f.content })),
          `${issue.title}\n\nAutomated by Floor Agents (${devAgent.name})\nTask: ${issue.id}\nReview cycle: ${state.reviewCycle}`,
        )
        console.log(`[orchestrator] committed: ${sha.slice(0, 8)}`)
        state = await advanceState(state, 'creating_pr', { commitSha: sha }, stateStore)
      }

      // Step: create PR
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
            '**Files changed:**',
            ...state.parsedOutput.files.map(f => `- \`${f.path}\``),
            '',
            `**Agent:** ${devAgent.name} (\`${devAgent.llm.model}\`)`,
            `**Cost:** $${state.costUsd.toFixed(4)}`,
          ].join('\n'),
        )

        console.log(`[orchestrator] PR created: ${pr.url}`)
        await comment(issue.id, `📝 **PR created:** ${pr.url}`)

        const nextStep = reviewer ? 'reviewing' : 'updating_issue'
        state = await advanceState(state, nextStep, { prUrl: pr.url, prId: pr.id }, stateStore)
      }

      // Step: CTO reviews
      if (state.step === 'reviewing' && reviewer && state.prId) {
        state = await runReviewAgent(issue, reviewer, state)
      }

      // Step: revision loop
      if (state.step === 'revision') {
        if (state.reviewCycle >= MAX_REVIEW_CYCLES) {
          console.log(`[orchestrator] max review cycles (${MAX_REVIEW_CYCLES}) reached`)
          await comment(issue.id, `⚠️ **Max review cycles reached** (${MAX_REVIEW_CYCLES}). Needs human review.`)
          await taskAdapter.setLabel(issue.id, 'needs-human')
          state = await advanceState(state, 'updating_issue', {}, stateStore)
        } else {
          const feedback = state.reviewVerdict?.comments ?? 'Changes requested.'
          console.log(`[orchestrator] revision ${state.reviewCycle}: ${devAgent.name} addressing feedback...`)

          state = await advanceState(state, 'building_context', { parsedOutput: null, reviewVerdict: null }, stateStore)
          state = await runDevAgent(issue, devAgent, state, feedback)

          if (state.step === 'validating_output' && state.parsedOutput) {
            const violations = validateAgentOutput(state.parsedOutput, guardrails)
            if (violations.length > 0) {
              const details = violations.map(v => `- ${v.detail}`).join('\n')
              await comment(issue.id, `❌ **Guardrail violations on revision:**\n${details}`)
              await taskAdapter.setLabel(issue.id, 'needs-human')
              state = await advanceState(state, 'failed', { error: `Guardrail violations: ${violations.length}` }, stateStore)
              return
            }

            if (state.branchName) {
              console.log(`[orchestrator] committing revision (${state.parsedOutput.files.length} files)`)
              const sha = await gitAdapter.commitFiles(
                company.project.repo,
                state.branchName,
                state.parsedOutput.files.map(f => ({ path: f.path, content: f.content })),
                `Address review feedback (cycle ${state.reviewCycle})\n\nAutomated by Floor Agents (${devAgent.name})\nTask: ${issue.id}`,
              )
              console.log(`[orchestrator] committed revision: ${sha.slice(0, 8)}`)
              state = await advanceState(state, 'reviewing', { commitSha: sha }, stateStore)

              if (reviewer && state.prId) {
                state = await runReviewAgent(issue, reviewer, state)

                if (state.step === 'revision') {
                  return executeTask(issue, devAgent, state)
                }
              }
            }
          }
        }
      }

      // Step: done
      if (state.step === 'updating_issue') {
        const totalDuration = formatDuration(Math.round(performance.now() - taskStart))
        const totalCost = `$${state.costUsd.toFixed(4)}`
        const cycles = state.reviewCycle > 0 ? `${state.reviewCycle} review cycle${state.reviewCycle > 1 ? 's' : ''}` : 'no review'

        const wasApproved = state.reviewVerdict?.decision === 'approve'

        await comment(issue.id, [
          wasApproved
            ? `✅ **Done** — approved by ${reviewer?.name ?? 'reviewer'} and ready for human review`
            : state.prUrl
              ? `✅ **Done** — PR ready for human review`
              : '✅ **Done**',
          '',
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Duration | ${totalDuration} |`,
          `| Cost | ${totalCost} |`,
          `| Review cycles | ${cycles} |`,
          state.prUrl ? `| PR | ${state.prUrl} |` : '',
        ].filter(Boolean).join('\n'))

        await taskAdapter.setStatus(issue.id, 'in_review')
        state = await advanceState(state, 'done', {}, stateStore)
        console.log(`[orchestrator] done: ${issue.title} (${cycles}, ${totalDuration}, ${totalCost})`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[orchestrator] error: ${message}`)

      state = await advanceState(state, 'failed', { error: message }, stateStore)

      try {
        await comment(issue.id, [
          `❌ **Agent error**`,
          '',
          `\`\`\``,
          message,
          `\`\`\``,
          '',
          'This issue has been labeled `needs-human`.',
        ].join('\n'))
        await taskAdapter.setLabel(issue.id, 'needs-human')
      } catch {}
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────

  return {
    async start() {
      console.log('[orchestrator] starting...')

      const reviewer = findReviewer()
      if (reviewer) {
        console.log(`[orchestrator] team mode: dev agents + ${reviewer.name} (${reviewer.llm.provider}/${reviewer.llm.model})`)
      } else {
        console.log('[orchestrator] solo mode: no reviewer configured')
      }

      const existing = await stateStore.list()
      const incomplete = existing.filter(s => s.step !== 'done' && s.step !== 'failed')

      if (incomplete.length > 0) {
        console.log(`[orchestrator] resuming ${incomplete.length} incomplete tasks`)
        for (const state of incomplete) {
          const issue = await taskAdapter.getIssue(state.issueId)
          if (!issue) continue
          const agent = findAgent(state.agentId)
          if (!agent) continue
          await executeTask(issue, agent, state)
        }
      }

      const knownIds = new Set(existing.map(s => s.issueId))

      console.log('[orchestrator] watching for tasks...\n')

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
              await comment(event.issue.id, '⏸️ **Daily cost limit reached.** Will resume tomorrow or when limit is increased.')
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
