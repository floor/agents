import { engineStopping } from './lifecycle.ts'
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
import { privateSourceDenials } from '@floor-agents/core'
import { runToolUseLoop, type LLMAdapterResolver } from './llm-runner.ts'
import { parseToolCallOutput } from './output-parser.ts'
import { validateAgentOutput } from './guardrails.ts'
import { runReviewAgent, MAX_REVIEW_CYCLES } from './review.ts'
import { NATIVE_PROVIDERS, runNativeDevAgent, runNativeReviewAgent, type NativeAgentDeps } from './native-runner.ts'
import type { CostTracker } from './cost-tracker.ts'
import { commitApiWorkspace } from './api-workspace.ts'
import { verificationSummary } from './verification.ts'
import { requireVerification } from './verified-commit.ts'
import { gitText } from './worktree.ts'
import { buildPrBody } from './pr-body.ts'
import { costNote, metaLine } from './cost-note.ts'
import { AgentStopped, stopReport, crashReport } from './stop-report.ts'
import { signComments, agentSignature, sign, ENGINE_SIGNATURE } from './comment-signature.ts'
import { discussionSection } from './discussion.ts'
import { committeePrReviewEnabled, executeCommitteePrReview } from './committee-pr-review.ts'
import type { Gateway } from '@floor-agents/gateway'
import type { ExternalVoterHost } from './committee-pipeline.ts'

// ── Helpers ───────────────────────────────────────────────────────

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * The state a run starts from. A retry starts over — a new branch tip, a new
 * turn — but not from nothing: the attempts and reviews so far come along.
 */
export function freshState(issueId: string, agentId: string, history: Pick<ExecutionState, 'attempts' | 'reviews'> = {}): ExecutionState {
  return { ...makeState(issueId, agentId), ...history }
}

function makeState(issueId: string, agentId: string): ExecutionState {
  const now = new Date().toISOString()
  return {
    issueId, agentId, step: 'pending', startedAt: now,
    branchName: null, commitSha: null, prUrl: null, prId: null,
    llmResponse: null, parsedOutput: null, reviewVerdict: null,
    reviewCycle: 0, costUsd: 0, error: null, updatedAt: now,
  }
}

async function advanceState(state: ExecutionState, step: ExecutionStep, updates: Partial<ExecutionState>, store: StateStore): Promise<ExecutionState> {
  const next: ExecutionState = { ...state, step, ...updates, updatedAt: new Date().toISOString() }
  await store.save(next)
  return next
}

/** Comments the implementer should read this turn; a fetch failure is no comments. */
async function loadDiscussion(adapter: TaskAdapter, issueId: string): Promise<string> {
  if (!adapter.getComments) return ''
  try {
    return discussionSection(await adapter.getComments(issueId))
  } catch (err) {
    console.error(`[orchestrator] could not read discussion: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

// ── Dependencies ─────────────────────────────────────────────────

export type PipelineDeps = {
  readonly company: CompanyConfig
  readonly taskAdapter: TaskAdapter
  readonly gitAdapter: GitAdapter
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly getAdapter: LLMAdapterResolver
  readonly findReviewer: () => AgentDefinition | undefined
  /** For tests: the native implementer's CLI, instead of spawning one. */
  readonly runAgent?: NativeAgentDeps['runAgent']
  /** Shared with the committee pipeline so external voters can review a PR. */
  readonly gateway?: Gateway
  /** Starts CLI bridges for external voters for the duration of a committee PR review. */
  readonly externalVoters?: ExternalVoterHost
}

// ── API dev agent (tool use) ─────────────────────────────────────

async function runApiDevAgent(
  issue: Issue, agent: AgentDefinition, state: ExecutionState, deps: PipelineDeps, reviewComments?: string, discussion?: string,
): Promise<ExecutionState> {
  const { company, taskAdapter, contextBuilder, stateStore, costTracker, getAdapter } = deps

  state = await advanceState(state, 'calling_llm', {}, stateStore)

  if (!costTracker.canStartNewTask(company.costs)) throw new Error('Daily cost limit reached.')

  const ctx = await contextBuilder.build({ agent, issue, project: company.project, reviewComments, discussion, ref: state.commitSha ?? state.branchName ?? undefined })
  const isRevision = !!reviewComments

  console.log(`[${agent.id}] calling LLM (${agent.llm.model})...`)
  await taskAdapter.addComment(issue.id, [
    isRevision ? `⏳ **${agent.name}** is addressing review feedback...` : `⏳ **${agent.name}** is writing code...`,
    `> Model: \`${agent.llm.model}\` via ${agent.llm.provider}`,
    `> Context: ${ctx.estimatedTokens} tokens`,
  ].join('\n'))

  const result = await runToolUseLoop(agent, ctx.systemPrompt, [{ role: 'user', content: ctx.userMessage }], ctx.tools, getAdapter)
  costTracker.recordCost(issue.id, result.totalCost)
  console.log(`[${agent.id}] LLM: ${result.totalInputTokens} in, ${result.totalOutputTokens} out, $${result.totalCost.toFixed(4)}, ${formatDuration(result.durationMs)}`)

  const costCheck = costTracker.checkTaskCost(issue.id, company.costs)
  if (!costCheck.ok) throw new Error(costCheck.message)
  if (costCheck.message) await taskAdapter.addComment(issue.id, `⚠️ ${costCheck.message}`)

  state = await advanceState(state, 'parsing_output', { llmResponse: result.content, costUsd: costTracker.getTaskCost(issue.id) }, stateStore)

  const output = parseToolCallOutput({
    content: result.content, toolCalls: result.toolCalls, stopReason: 'end_turn',
    usage: { inputTokens: result.totalInputTokens, outputTokens: result.totalOutputTokens, cost: result.totalCost },
    provider: agent.llm.provider, model: agent.llm.model, durationMs: result.durationMs,
  })

  if (output.parseErrors.length > 0 && output.files.length === 0) {
    console.log(`[${agent.id}] no files from tool calls, retrying...`)
    await taskAdapter.addComment(issue.id, `🔄 **${agent.name}** produced no files. Retrying...`)

    const retry = await runToolUseLoop(agent, ctx.systemPrompt, [
      { role: 'user', content: ctx.userMessage },
      { role: 'assistant', content: result.content || 'I need to provide the implementation using tools.' },
      { role: 'user', content: 'Please provide your implementation using the write_file tool for each file you want to create or modify.' },
    ], ctx.tools, getAdapter)
    costTracker.recordCost(issue.id, retry.totalCost)

    const retryOutput = parseToolCallOutput({
      content: retry.content, toolCalls: retry.toolCalls, stopReason: 'end_turn',
      usage: { inputTokens: retry.totalInputTokens, outputTokens: retry.totalOutputTokens, cost: retry.totalCost },
      provider: agent.llm.provider, model: agent.llm.model, durationMs: retry.durationMs,
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
    `> ${metaLine([`${formatBytes(totalSize)} total`, formatDuration(result.durationMs), costNote(result.totalCost)])}`,
  ].join('\n'))

  return advanceState(state, 'validating_output', { parsedOutput: output }, stateStore)
}

// ── Shared review dispatcher ─────────────────────────────────────

function isNative(agent: AgentDefinition): boolean {
  return NATIVE_PROVIDERS.has(agent.llm.provider)
}

/**
 * The review turns, signed by the reviewer rather than by the implementer whose
 * signature the run's adapter carries — so `unsigned` is the adapter as the
 * caller gave it, before either signature.
 */
async function dispatchReview(
  issue: Issue, reviewer: AgentDefinition, state: ExecutionState, deps: PipelineDeps, unsigned: TaskAdapter,
): Promise<ExecutionState> {
  const taskAdapter = signComments(unsigned, agentSignature(reviewer, 'reviewer'))
  if (isNative(reviewer)) {
    return runNativeReviewAgent(issue, reviewer, state, {
      stateStore: deps.stateStore,
      costTracker: deps.costTracker,
      addComment: (id, text) => taskAdapter.addComment(id, text),
      addPRComment: (prId, body) => deps.gitAdapter.addPRComment(deps.company.project.repo, prId, body),
      getPRDiff: (prId) => deps.gitAdapter.getPRDiff(deps.company.project.repo, prId),
      project: deps.company.project,
      maxReviewCycles: MAX_REVIEW_CYCLES,
      denyRead: privateSourceDenials(deps.company, reviewer.llm.provider),
    })
  }

  return runReviewAgent(issue, reviewer, state, {
    company: deps.company,
    gitAdapter: deps.gitAdapter,
    taskAdapter,
    stateStore: deps.stateStore,
    costTracker: deps.costTracker,
    getAdapter: deps.getAdapter,
  })
}

async function runConfiguredReview(
  issue: Issue,
  state: ExecutionState,
  deps: PipelineDeps,
  unsigned: TaskAdapter,
  useCommittee: boolean,
  reviewer: AgentDefinition | undefined,
): Promise<ExecutionState> {
  await assertVerified(state, deps)
  if (useCommittee) {
    return executeCommitteePrReview(issue, state, {
      company: deps.company,
      taskAdapter: unsigned,
      gitAdapter: deps.gitAdapter,
      contextBuilder: deps.contextBuilder,
      stateStore: deps.stateStore,
      costTracker: deps.costTracker,
      getAdapter: deps.getAdapter,
      ...(deps.gateway ? { gateway: deps.gateway } : {}),
      ...(deps.externalVoters ? { externalVoters: deps.externalVoters } : {}),
    })
  }
  if (reviewer) return dispatchReview(issue, reviewer, state, deps, unsigned)
  return state
}

// ── Main task pipeline ───────────────────────────────────────────

export async function executeTask(
  issue: Issue, devAgent: AgentDefinition, deps: PipelineDeps, existingState?: ExecutionState,
): Promise<void> {
  let state = existingState ?? makeState(issue.id, devAgent.id)
  // Every comment this run posts is signed with the agent that is working, so
  // the account's name is not the only thing a reader sees.
  const { company, gitAdapter, stateStore } = deps
  const unsigned = deps.taskAdapter
  const taskAdapter = signComments(unsigned, agentSignature(devAgent, 'implementer'))
  deps = { ...deps, taskAdapter }
  const { guardrails } = company
  const reviewer = deps.findReviewer()
  const useCommitteeReview = committeePrReviewEnabled(company)
  const taskStart = performance.now()
  const devIsNative = isNative(devAgent)

  try {
    if (devIsNative || company.project.verification) requireVerification(company.project)
    // Step: pending → create branch
    if (state.step === 'pending') {
      const issueKey = issue.labels.find(l => /^[A-Z]+-\d+$/.test(l)) ?? issue.id.slice(0, 8)
      const branchName = `agent/${issueKey}-${slugify(issue.title)}`

      console.log(`[orchestrator] creating branch: ${branchName}`)
      await gitAdapter.createBranch(company.project.repo, branchName, company.project.baseBranch)
      state = await advanceState(state, 'building_context', { branchName }, stateStore)
      // The board shows the pickup as it happens: a person watching the queue
      // sees the issue move, not only the comments under it.
      await unsigned.setStatus(issue.id, 'in_progress')

      await taskAdapter.addComment(issue.id, [
        `🤖 **${devAgent.name}** is picking up this task`,
        '',
        '**Team:**',
        `- Developer: **${devAgent.name}** (\`${devAgent.llm.model}\` via ${devAgent.llm.provider})`,
        useCommitteeReview
          ? `- Reviewers: committee (${company.agents.filter(a => a.capabilities.includes('vote')).map(a => a.name).join(', ')})`
          : reviewer ? `- Reviewer: **${reviewer.name}** (\`${reviewer.llm.model}\` via ${reviewer.llm.provider})` : '',
        '',
        `**Branch:** \`${branchName}\``,
        `**Mode:** ${devIsNative ? 'native (worktree)' : 'API (tool use)'}`,
        `**Pipeline:** branch → code → guardrails${company.project.verification ? ' → checks' : ''} → commit → PR${(useCommitteeReview || reviewer) ? ' → review' : ''}`,
      ].filter(Boolean).join('\n'))
    }

    // Step: dev writes code (two paths)
    if (state.step === 'building_context' || state.step === 'calling_llm' || state.step === 'parsing_output') {
      const discussion = await loadDiscussion(unsigned, issue.id)
      if (devIsNative) {
        state = await runNativeDevAgent(issue, devAgent, state, {
          contextBuilder: deps.contextBuilder,
          stateStore, costTracker: deps.costTracker,
          addComment: (id, text) => taskAdapter.addComment(id, text),
          setLabel: (id, label) => taskAdapter.setLabel(id, label),
          project: company.project,
          guardrails,
          denyRead: privateSourceDenials(company, devAgent.llm.provider),
          ...(deps.runAgent ? { runAgent: deps.runAgent } : {}),
          ...(discussion ? { discussion } : {}),
        })
      } else {
        state = await runApiDevAgent(issue, devAgent, state, deps, undefined, discussion)
      }
    }

    // API output validation; native validates the actual Git diff before publishing.
    if (!devIsNative && state.step === 'validating_output' && state.parsedOutput) {
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

    // Step: commit via GitHub API (API path only — native already committed)
    if (!devIsNative && state.step === 'committing_files' && state.branchName && state.parsedOutput) {
      console.log(`[orchestrator] committing ${state.parsedOutput.files.length} files`)
      if (company.project.verification) {
        state = await commitApiWorkspace(state, deps, `${issue.title}\n\nTask: ${issue.id}`)
        state = await advanceState(state, 'creating_pr', {}, stateStore)
      } else {
        const sha = await gitAdapter.commitFiles(
          company.project.repo, state.branchName,
          state.parsedOutput.files.map(f => ({ path: f.path, content: f.content })),
          `${issue.title}\n\nAutomated by Floor Agents (${devAgent.name})\nTask: ${issue.id}\nReview cycle: ${state.reviewCycle}`,
        )
        console.log(`[orchestrator] committed: ${sha.slice(0, 8)}`)
        state = await advanceState(state, 'creating_pr', { commitSha: sha }, stateStore)
      }
    }

    // Step: create PR (both paths)
    if (state.step === 'creating_pr' && state.branchName) {
      await assertVerified(state, deps)
      // A diff stat is available when the commit is in the local object store — the
      // native path pushes from a worktree of project.root. The API path commits
      // through GitHub, so its PR lists the files it wrote instead.
      let diffStat: string | undefined
      if (company.project.root && state.baseSha && state.commitSha) {
        diffStat = await gitText(company.project.root, ['diff', '--stat', state.baseSha, state.commitSha]).catch(() => undefined)
      }
      const body = buildPrBody({ issue, agent: devAgent, state, repo: company.project.repo, ...(diffStat ? { diffStat } : {}) })
      const pr = await gitAdapter.createPR(company.project.repo, state.branchName, issue.title, body, company.project.baseBranch)
      console.log(`[orchestrator] PR created: ${pr.url}`)
      await taskAdapter.addComment(issue.id, `📝 **PR created:** ${pr.url}`)

      const nextStep = (useCommitteeReview || reviewer) ? 'reviewing' : 'updating_issue'
      state = await advanceState(state, nextStep, { prUrl: pr.url, prId: pr.id }, stateStore)
    }

    // Step: review (dispatches to native or API based on reviewer's provider)
    if (state.step === 'reviewing' && state.prId) {
      state = await runConfiguredReview(issue, state, deps, unsigned, useCommitteeReview, reviewer)
    }

    // Step: revision loop
    if (state.step === 'revision') {
      if (state.reviewCycle >= MAX_REVIEW_CYCLES) {
        console.log(`[orchestrator] max review cycles (${MAX_REVIEW_CYCLES}) reached`)
        await taskAdapter.addComment(issue.id, `⚠️ **Max review cycles reached** (${MAX_REVIEW_CYCLES}). Needs human review.`)
        await taskAdapter.setLabel(issue.id, 'needs-human')
        state = await advanceState(state, 'failed', { error: 'Max review cycles reached; needs human review' }, stateStore)
        return
      } else {
        const feedback = state.reviewVerdict?.comments ?? 'Changes requested.'
        console.log(`[orchestrator] revision ${state.reviewCycle}: ${devAgent.name} addressing feedback...`)
        state = await advanceState(state, 'building_context', { parsedOutput: null, reviewVerdict: null, verification: undefined }, stateStore)
        const discussion = await loadDiscussion(unsigned, issue.id)

        if (devIsNative) {
          state = await runNativeDevAgent(issue, devAgent, state, {
            contextBuilder: deps.contextBuilder,
            stateStore, costTracker: deps.costTracker,
            addComment: (id, text) => taskAdapter.addComment(id, text),
            setLabel: (id, label) => taskAdapter.setLabel(id, label),
            project: company.project,
            guardrails,
            denyRead: privateSourceDenials(company, devAgent.llm.provider),
            ...(deps.runAgent ? { runAgent: deps.runAgent } : {}),
            ...(discussion ? { discussion } : {}),
          }, feedback)

          // Native already committed — skip to review
          if (state.step === 'creating_pr') {
            state = await advanceState(state, 'reviewing', {}, stateStore)
          }
        } else {
          state = await runApiDevAgent(issue, devAgent, state, deps, feedback, discussion)

          if (state.step === 'validating_output' && state.parsedOutput) {
            const violations = validateAgentOutput(state.parsedOutput, guardrails)
            if (violations.length > 0) {
              await taskAdapter.addComment(issue.id, `❌ **Guardrail violations on revision:**\n${violations.map(v => `- ${v.detail}`).join('\n')}`)
              await taskAdapter.setLabel(issue.id, 'needs-human')
              state = await advanceState(state, 'failed', { error: `Guardrail violations: ${violations.length}` }, stateStore)
              return
            }
            if (state.branchName) {
              if (company.project.verification) {
                state = await commitApiWorkspace(state, deps, `Address review feedback (cycle ${state.reviewCycle})\n\nTask: ${issue.id}`)
                state = await advanceState(state, 'reviewing', {}, stateStore)
              } else {
                const sha = await gitAdapter.commitFiles(
                  company.project.repo, state.branchName,
                  state.parsedOutput.files.map(f => ({ path: f.path, content: f.content })),
                  `Address review feedback (cycle ${state.reviewCycle})\n\nAutomated by Floor Agents (${devAgent.name})\nTask: ${issue.id}`,
                )
                state = await advanceState(state, 'reviewing', { commitSha: sha }, stateStore)
              }
            }
          }
        }

        // Re-review
        if (state.step === 'reviewing' && state.prId) {
          state = await runConfiguredReview(issue, state, deps, unsigned, useCommitteeReview, reviewer)
          if (state.step === 'revision') {
            return executeTask(issue, devAgent, deps, state)
          }
        }
      }
    }

    // Step: done
    if (state.step === 'updating_issue') {
      await assertVerified(state, deps)
      const totalDuration = formatDuration(Math.round(performance.now() - taskStart))
      const totalCost = costNote(state.costUsd)
      const cycles = state.reviewCycle > 0 ? `${state.reviewCycle} review cycle${state.reviewCycle > 1 ? 's' : ''}` : 'no review'
      const wasApproved = state.reviewVerdict?.decision === 'approve'

      await taskAdapter.addComment(issue.id, [
        wasApproved
          ? `✅ **Done** — approved by ${useCommitteeReview ? 'the committee' : (reviewer?.name ?? 'reviewer')} and ready for human review`
          : state.prUrl ? `✅ **Done** — PR ready for human review` : '✅ **Done**',
        '', '| Metric | Value |', '|--------|-------|',
        `| Duration | ${totalDuration} |`, totalCost ? `| Cost | ${totalCost} |` : '', `| Review cycles | ${cycles} |`,
        state.prUrl ? `| PR | ${state.prUrl} |` : '',
        state.verification ? verificationSummary(state.verification) : '',
      ].filter(Boolean).join('\n'))

      await taskAdapter.setStatus(issue.id, 'in_review')
      state = await advanceState(state, 'done', {}, stateStore)
      console.log(`[orchestrator] done: ${issue.title} (${metaLine([cycles, totalDuration, totalCost || 'no metered cost'])})`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (engineStopping()) {
      // Whatever broke, broke because the engine is stopping and ended its children.
      // Nothing failed: no report, no label, and the step stays where a start resumes it.
      console.log(`[orchestrator] stopped during ${state.step}: ${issue.key ?? issue.id} resumes at the next start`)
      return
    }
    console.error(`[orchestrator] error: ${message}`)
    state = await advanceState(await stateStore.get(issue.id) ?? state, 'failed', { error: message }, stateStore)
    // The engine is the one reporting — the agent that stopped did not write
    // this — so the comment carries the engine's signature, not the agent's.
    const key = issue.key ?? issue.id
    const report = err instanceof AgentStopped ? stopReport(devAgent.name, err.message, err.written, key) : crashReport(message, key)
    try {
      await unsigned.addComment(issue.id, sign(report, ENGINE_SIGNATURE))
      await unsigned.setLabel(issue.id, 'needs-human')
    } catch {}
  }
}

async function assertVerified(state: ExecutionState, deps: PipelineDeps): Promise<void> {
  if (deps.company.project.verification && (!state.verification?.passed || state.verification.commitSha !== state.commitSha)) {
    throw new Error('No passing engine verification for the current commit; refusing to publish or complete')
  }
  if (deps.company.project.verification) {
    const remote = await gitText(deps.company.project.root!, ['ls-remote', '--exit-code', 'origin', `refs/heads/${state.branchName}`])
    if (remote.split(/\s/)[0] !== state.commitSha) throw new Error('Remote branch changed after verification; refusing a stale result')
  }
}
