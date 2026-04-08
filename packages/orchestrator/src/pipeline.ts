import type {
  CompanyConfig,
  TaskAdapter,
  GitAdapter,
  Issue,
  ExecutionState,
  ExecutionStep,
  StateStore,
  AgentDefinition,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import { runToolUseLoop, type LLMAdapterResolver } from './llm-runner.ts'
import { parseToolCallOutput } from './output-parser.ts'
import { validateAgentOutput } from './guardrails.ts'
import { runReviewAgent, MAX_REVIEW_CYCLES } from './review.ts'
import { createWorktree, commitAndPushWorktree, removeWorktree } from './worktree.ts'
import type { CostTracker } from './cost-tracker.ts'

const NATIVE_PROVIDERS = new Set(['claude-code'])

// ── Helpers ───────────────────────────────────────────────────────

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

// ── Pipeline dependencies ────────────────────────────────────────

export type PipelineDeps = {
  readonly company: CompanyConfig
  readonly taskAdapter: TaskAdapter
  readonly gitAdapter: GitAdapter
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly getAdapter: LLMAdapterResolver
  readonly findReviewer: () => AgentDefinition | undefined
}

// ── Dev agent ────────────────────────────────────────────────────

async function runDevAgent(
  issue: Issue,
  agent: AgentDefinition,
  state: ExecutionState,
  deps: PipelineDeps,
  reviewComments?: string,
): Promise<ExecutionState> {
  const { company, taskAdapter, contextBuilder, stateStore, costTracker, getAdapter } = deps

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

  await taskAdapter.addComment(issue.id, [
    isRevision
      ? `⏳ **${agent.name}** is addressing review feedback...`
      : `⏳ **${agent.name}** is writing code...`,
    `> Model: \`${agent.llm.model}\` via ${agent.llm.provider}`,
    `> Context: ${ctx.estimatedTokens} tokens`,
  ].join('\n'))

  const result = await runToolUseLoop(agent, ctx.systemPrompt, [{ role: 'user', content: ctx.userMessage }], ctx.tools, getAdapter)

  costTracker.recordCost(issue.id, result.totalCost)
  console.log(`[${agent.id}] LLM: ${result.totalInputTokens} in, ${result.totalOutputTokens} out, $${result.totalCost.toFixed(4)}, ${formatDuration(result.durationMs)}`)

  const costCheck = costTracker.checkTaskCost(issue.id, company.costs)
  if (!costCheck.ok) throw new Error(costCheck.message)
  if (costCheck.message) {
    await taskAdapter.addComment(issue.id, `⚠️ ${costCheck.message}`)
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
    await taskAdapter.addComment(issue.id, `🔄 **${agent.name}** produced no files. Retrying...`)

    const retry = await runToolUseLoop(
      agent,
      ctx.systemPrompt,
      [
        { role: 'user', content: ctx.userMessage },
        { role: 'assistant', content: result.content || 'I need to provide the implementation using tools.' },
        { role: 'user', content: 'Please provide your implementation using the write_file tool for each file you want to create or modify.' },
      ],
      ctx.tools,
      getAdapter,
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
      await taskAdapter.addComment(issue.id, `❌ **${agent.name}** could not produce structured output after retry.`)
      await taskAdapter.setLabel(issue.id, 'needs-human')
      return advanceState(state, 'failed', { error: 'No files produced after retry', parsedOutput: retryOutput }, stateStore)
    }

    return advanceState(state, 'validating_output', { parsedOutput: retryOutput }, stateStore)
  }

  const totalSize = output.files.reduce((sum, f) => sum + new TextEncoder().encode(f.content).length, 0)
  await taskAdapter.addComment(issue.id, [
    `✅ **${agent.name}** produced ${output.files.length} file${output.files.length === 1 ? '' : 's'}:`,
    ...output.files.map(f => `- \`${f.path}\``),
    '',
    `> ${formatBytes(totalSize)} total | ${formatDuration(result.durationMs)} | $${result.totalCost.toFixed(4)}`,
  ].join('\n'))

  return advanceState(state, 'validating_output', { parsedOutput: output }, stateStore)
}

// ── Native agent (Claude Code on worktree) ──────────────────────

async function runNativeAgent(
  issue: Issue,
  agent: AgentDefinition,
  state: ExecutionState,
  deps: PipelineDeps,
  reviewComments?: string,
): Promise<ExecutionState> {
  const { company, taskAdapter, contextBuilder, stateStore, costTracker, getAdapter } = deps

  state = await advanceState(state, 'calling_llm', {}, stateStore)

  if (!costTracker.canStartNewTask(company.costs)) {
    throw new Error('Daily cost limit reached.')
  }

  // Create a worktree for the agent to work in
  const worktree = await createWorktree(state.branchName!)

  const isRevision = !!reviewComments
  console.log(`[${agent.id}] native agent on worktree: ${worktree.path}`)

  await taskAdapter.addComment(issue.id, [
    isRevision
      ? `⏳ **${agent.name}** is addressing review feedback...`
      : `⏳ **${agent.name}** is working on the code...`,
    `> Model: \`${agent.llm.model}\` via ${agent.llm.provider} (native mode)`,
    `> Worktree: \`${worktree.branch}\``,
  ].join('\n'))

  try {
    // Build context hints for the agent
    const ctx = await contextBuilder.build({
      agent,
      issue,
      project: company.project,
      reviewComments,
    })

    // Build the prompt — include context as hints, not constraints
    const promptParts = [
      ctx.systemPrompt,
      '',
      '## Task',
      `**${issue.title}**`,
      issue.body || '',
    ]

    if (reviewComments) {
      promptParts.push('', '## Review Feedback (address these)', reviewComments)
    }

    promptParts.push(
      '',
      '## Instructions',
      'You are working directly on a git branch. Edit files, run tests, iterate until the code is correct.',
      'Run `bun run typecheck` and `bun test` before finishing to make sure everything passes.',
      'Do NOT use write_file or pr_description tools — edit files directly.',
    )

    const prompt = promptParts.join('\n')

    // Spawn Claude Code on the worktree
    const start = performance.now()

    const { ANTHROPIC_API_KEY, ...cleanEnv } = process.env
    const args = [
      'claude',
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', '25',
    ]

    if (agent.llm.model) {
      args.push('--model', agent.llm.model)
    }

    const proc = Bun.spawn(args, {
      cwd: worktree.path,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...cleanEnv, CI: 'true' },
    })

    const timeout = setTimeout(() => proc.kill(), 600_000) // 10 min
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    clearTimeout(timeout)

    const durationMs = Math.round(performance.now() - start)

    // Parse result
    let cost = 0
    let resultText = ''
    try {
      const data = JSON.parse(stdout)
      resultText = data.result ?? ''
      cost = data.total_cost_usd ?? 0
    } catch {
      resultText = stdout || stderr
    }

    costTracker.recordCost(issue.id, cost)
    console.log(`[${agent.id}] native agent: ${formatDuration(durationMs)}, $${cost.toFixed(4)}, exit ${exitCode}`)

    if (exitCode !== 0 && exitCode !== 143) {
      throw new Error(`Claude Code failed (exit ${exitCode}): ${stderr.slice(0, 500)}`)
    }

    // Commit and push whatever changes were made
    const sha = await commitAndPushWorktree(
      worktree,
      `${issue.title}\n\nAutomated by Floor Agents (${agent.name})\nTask: ${issue.id}\nReview cycle: ${state.reviewCycle}`,
    )

    if (!sha) {
      await taskAdapter.addComment(issue.id, `❌ **${agent.name}** made no changes to the code.`)
      await taskAdapter.setLabel(issue.id, 'needs-human')
      return advanceState(state, 'failed', {
        error: 'Native agent made no changes',
        llmResponse: resultText,
        costUsd: costTracker.getTaskCost(issue.id),
      }, stateStore)
    }

    // Report success
    const diffStat = await Bun.$`git -C ${worktree.path} diff HEAD~1 --stat`.quiet()
    const diffText = diffStat.stdout.toString().trim()

    await taskAdapter.addComment(issue.id, [
      `✅ **${agent.name}** completed work (native mode):`,
      '```',
      diffText,
      '```',
      `> ${formatDuration(durationMs)} | $${cost.toFixed(4)}`,
    ].join('\n'))

    return advanceState(state, 'creating_pr', {
      commitSha: sha,
      costUsd: costTracker.getTaskCost(issue.id),
      llmResponse: resultText,
    }, stateStore)
  } finally {
    await removeWorktree(worktree)
  }
}

// ── Main task pipeline ───────────────────────────────────────────

export async function executeTask(
  issue: Issue,
  devAgent: AgentDefinition,
  deps: PipelineDeps,
  existingState?: ExecutionState,
): Promise<void> {
  let state = existingState ?? makeState(issue.id, devAgent.id)
  const { company, taskAdapter, gitAdapter, stateStore } = deps
  const { guardrails } = company
  const reviewer = deps.findReviewer()
  const taskStart = performance.now()

  try {
    // Step: pending → create branch
    if (state.step === 'pending') {
      const issueKey = issue.labels.find(l => /^[A-Z]+-\d+$/.test(l))
        ?? issue.id.slice(0, 8)
      const branchName = `agent/${issueKey}-${slugify(issue.title)}`

      const isNative = NATIVE_PROVIDERS.has(devAgent.llm.provider)

      console.log(`[orchestrator] creating branch: ${branchName}`)
      await gitAdapter.createBranch(company.project.repo, branchName)
      state = await advanceState(state, 'building_context', { branchName }, stateStore)

      await taskAdapter.addComment(issue.id, [
        `🤖 **${devAgent.name}** is picking up this task`,
        '',
        '**Team:**',
        `- Developer: **${devAgent.name}** (\`${devAgent.llm.model}\` via ${devAgent.llm.provider})`,
        reviewer ? `- Reviewer: **${reviewer.name}** (\`${reviewer.llm.model}\` via ${reviewer.llm.provider})` : '',
        '',
        `**Branch:** \`${branchName}\``,
        `**Mode:** ${isNative ? 'native (worktree)' : 'API (tool use)'}`,
        `**Pipeline:** branch → code${isNative ? '' : ' → guardrails'} → commit → PR${reviewer ? ' → review' : ''}`,
      ].filter(Boolean).join('\n'))
    }

    const isNativeAgent = NATIVE_PROVIDERS.has(devAgent.llm.provider)

    if (isNativeAgent) {
      // ── Native path: Claude Code works directly on a worktree ──
      if (state.step === 'building_context' || state.step === 'calling_llm') {
        state = await runNativeAgent(issue, devAgent, state, deps)
      }
    } else {
      // ── API path: tool use → parse → guardrails → commit via API ──

      // Step: dev agent writes code
      if (state.step === 'building_context' || state.step === 'calling_llm' || state.step === 'parsing_output') {
        state = await runDevAgent(issue, devAgent, state, deps)
      }

      // Step: guardrails
      if (state.step === 'validating_output' && state.parsedOutput) {
        const violations = validateAgentOutput(state.parsedOutput, guardrails)

        if (violations.length > 0) {
          const details = violations.map(v => `- ${v.detail}`).join('\n')
          await taskAdapter.addComment(issue.id, `❌ **Guardrail violations** — changes will not be committed:\n${details}`)
          await taskAdapter.setLabel(issue.id, 'needs-human')
          state = await advanceState(state, 'failed', { error: `Guardrail violations: ${violations.length}` }, stateStore)
          return
        }

        await taskAdapter.addComment(issue.id, `🔍 **Guardrails passed** — ${state.parsedOutput.files.length} files validated`)
        state = await advanceState(state, 'committing_files', {}, stateStore)
      }

      // Step: commit files via GitHub API
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
    }

    // Step: create PR
    if (state.step === 'creating_pr' && state.branchName) {
      const prBody = state.parsedOutput?.prDescription || [
        'Automated PR by Floor Agents',
        '',
        `**Task:** ${issue.title}`,
        issue.body ? `\n${issue.body}` : '',
        '',
        ...(state.parsedOutput?.files ?? []).map(f => `- \`${f.path}\``),
        '',
        `**Agent:** ${devAgent.name} (\`${devAgent.llm.model}\`)`,
        `**Cost:** $${state.costUsd.toFixed(4)}`,
      ].join('\n')

      const pr = await gitAdapter.createPR(
        company.project.repo,
        state.branchName,
        issue.title,
        prBody,
      )

      console.log(`[orchestrator] PR created: ${pr.url}`)
      await taskAdapter.addComment(issue.id, `📝 **PR created:** ${pr.url}`)

      const nextStep = reviewer ? 'reviewing' : 'updating_issue'
      state = await advanceState(state, nextStep, { prUrl: pr.url, prId: pr.id }, stateStore)
    }

    // Step: CTO reviews
    if (state.step === 'reviewing' && reviewer && state.prId) {
      const reviewDeps = {
        company,
        gitAdapter,
        taskAdapter,
        stateStore,
        costTracker: deps.costTracker,
        getAdapter: deps.getAdapter,
      }
      state = await runReviewAgent(issue, reviewer, state, reviewDeps)
    }

    // Step: revision loop
    if (state.step === 'revision') {
      if (state.reviewCycle >= MAX_REVIEW_CYCLES) {
        console.log(`[orchestrator] max review cycles (${MAX_REVIEW_CYCLES}) reached`)
        await taskAdapter.addComment(issue.id, `⚠️ **Max review cycles reached** (${MAX_REVIEW_CYCLES}). Needs human review.`)
        await taskAdapter.setLabel(issue.id, 'needs-human')
        state = await advanceState(state, 'updating_issue', {}, stateStore)
      } else {
        const feedback = state.reviewVerdict?.comments ?? 'Changes requested.'
        console.log(`[orchestrator] revision ${state.reviewCycle}: ${devAgent.name} addressing feedback...`)

        state = await advanceState(state, 'building_context', { parsedOutput: null, reviewVerdict: null }, stateStore)

        const isNativeRevision = NATIVE_PROVIDERS.has(devAgent.llm.provider)

        if (isNativeRevision) {
          // Native revision: re-run Claude Code on the worktree with feedback
          state = await runNativeAgent(issue, devAgent, state, deps, feedback)

          if (state.step === 'creating_pr') {
            // Already committed in worktree — go straight to review
            state = await advanceState(state, 'reviewing', {}, stateStore)
          }
        } else {
          // API revision: tool use → guardrails → commit via API
          state = await runDevAgent(issue, devAgent, state, deps, feedback)

          if (state.step === 'validating_output' && state.parsedOutput) {
            const violations = validateAgentOutput(state.parsedOutput, guardrails)
            if (violations.length > 0) {
              const details = violations.map(v => `- ${v.detail}`).join('\n')
              await taskAdapter.addComment(issue.id, `❌ **Guardrail violations on revision:**\n${details}`)
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
            }
          }
        }

        // Re-review after revision (both paths converge here)
        if (state.step === 'reviewing' && reviewer && state.prId) {
          const reviewDeps = {
            company,
            gitAdapter,
            taskAdapter,
            stateStore,
            costTracker: deps.costTracker,
            getAdapter: deps.getAdapter,
          }
          state = await runReviewAgent(issue, reviewer, state, reviewDeps)

          if (state.step === 'revision') {
            return executeTask(issue, devAgent, deps, state)
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

      await taskAdapter.addComment(issue.id, [
        wasApproved
          ? `✅ **Done** — approved by ${reviewer?.name ?? 'reviewer'} and ready for human review`
          : state.prUrl
            ? `✅ **Done** — PR ready for human review`
            : '✅ **Done**',
        '',
        '| Metric | Value |',
        '|--------|-------|',
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
      await taskAdapter.addComment(issue.id, [
        '❌ **Agent error**',
        '',
        '```',
        message,
        '```',
        '',
        'This issue has been labeled `needs-human`.',
      ].join('\n'))
      await taskAdapter.setLabel(issue.id, 'needs-human')
    } catch {}
  }
}
