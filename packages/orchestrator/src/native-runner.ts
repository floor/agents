import type {
  Issue,
  ExecutionState,
  ExecutionStep,
  StateStore,
  AgentDefinition,
  ReviewVerdict,
  ProjectConfig,
  GuardrailsConfig,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import { createWorktree, gitText, snapshotWorktree, removeWorktree } from './worktree.ts'
import { requireVerification, prepareWorkspace, verifyAndCommit, resolveBaseSha } from './verified-commit.ts'
import { verificationSummary } from './verification.ts'
import type { CostTracker } from './cost-tracker.ts'

export const NATIVE_PROVIDERS = new Set(['claude-code'])

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
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

type NativeRunResult = {
  readonly resultText: string
  readonly cost: number
  readonly durationMs: number
  readonly exitCode: number
}

async function spawnClaudeCode(
  prompt: string,
  cwd: string,
  model?: string,
  maxTurns = 25,
  timeoutMs = 600_000,
): Promise<NativeRunResult> {
  const { ANTHROPIC_API_KEY, ...cleanEnv } = process.env

  const args = [
    'claude',
    '-p', prompt,
    '--output-format', 'json',
    '--max-turns', String(maxTurns),
    '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep',
  ]

  if (model) {
    args.push('--model', model)
  }

  const start = performance.now()

  // ANTHROPIC_API_KEY is stripped from the child env (see cleanEnv above) so the
  // Claude Code subprocess authenticates via the local Max plan session instead of
  // routing through paid per-token API billing. Run `claude setup-token` once to
  // configure long-lived Max plan auth.
  const proc = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    detached: process.platform !== 'win32',
    env: { ...cleanEnv, CLAUDE_CODE_SKIP_HOOKS: '1' },
  })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    try {
      if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL')
      else proc.kill('SIGKILL')
    } catch { proc.kill('SIGKILL') }
  }, timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  clearTimeout(timeout)

  const durationMs = Math.round(performance.now() - start)

  let cost = 0
  let resultText = ''
  try {
    const data = JSON.parse(stdout)
    resultText = data.result ?? ''
    cost = data.total_cost_usd ?? 0
  } catch {
    resultText = stdout || stderr
  }

  return { resultText, cost, durationMs, exitCode: timedOut ? 143 : exitCode }
}

// ── Dev agent: native execution on worktree ─────────────────────

export type NativeAgentDeps = {
  readonly runAgent?: typeof spawnClaudeCode
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly addComment: (issueId: string, text: string) => Promise<void>
  readonly setLabel: (issueId: string, label: string) => Promise<void>
  readonly project: ProjectConfig
  readonly guardrails: GuardrailsConfig
}

export async function runNativeDevAgent(
  issue: Issue,
  agent: AgentDefinition,
  state: ExecutionState,
  deps: NativeAgentDeps,
  reviewComments?: string,
): Promise<ExecutionState> {
  const { contextBuilder, stateStore, costTracker, addComment } = deps

  requireVerification(deps.project)

  state = await advanceState(state, 'calling_llm', {}, stateStore)

  const worktree = await createWorktree(state.branchName!, deps.project.root)
  state = await advanceState(state, 'calling_llm', {
    workspacePath: worktree.path, baseSha: await resolveBaseSha(worktree, deps.project, state), verification: undefined,
  }, stateStore)
  const isRevision = !!reviewComments

  console.log(`[${agent.id}] native agent on worktree: ${worktree.path}`)

  await addComment(issue.id, [
    isRevision
      ? `⏳ **${agent.name}** is addressing review feedback...`
      : `⏳ **${agent.name}** is working on the code...`,
    `> Model: \`${agent.llm.model}\` via ${agent.llm.provider} (native mode)`,
    `> Worktree: \`${state.branchName}\``,
  ].join('\n'))

  try {
    await prepareWorkspace(worktree, deps.project)
    // Build context hints
    const ctx = await contextBuilder.build({
      agent,
      issue,
      project: deps.project,
      reviewComments,
      ref: worktree.initialSha,
    })

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
      `Project checks: ${deps.project.verification!.map(c => c.command.join(' ')).join('; ')}. The engine will run these independently.`,
      'Do not commit, push, or open a PR. The engine validates and publishes the final changes.',
      'Do NOT use write_file or pr_description tools — edit files directly.',
    )

    const result = await (deps.runAgent ?? spawnClaudeCode)(
      promptParts.join('\n'),
      worktree.path,
      agent.llm.model,
    )

    costTracker.recordCost(issue.id, result.cost)
    state = await advanceState(state, 'calling_llm', { costUsd: costTracker.getTaskCost(issue.id), llmResponse: result.resultText }, stateStore)
    console.log(`[${agent.id}] native agent: ${formatDuration(result.durationMs)}, $${result.cost.toFixed(4)}, exit ${result.exitCode}`)

    if (result.exitCode !== 0) {
      throw new Error(`Claude Code failed (exit ${result.exitCode}): ${result.resultText.slice(0, 500)}`)
    }

    state = await verifyAndCommit(
      worktree, deps.project, deps.guardrails, state, stateStore,
      `${issue.title}\n\nAutomated by Floor Agents (${agent.name})\nTask: ${issue.id}\nReview cycle: ${state.reviewCycle}`,
    )

    const diffText = await gitText(worktree.path, ['diff', state.baseSha!, state.commitSha!, '--stat'])

    await addComment(issue.id, [
      `✅ **${agent.name}** completed work (native mode):`,
      '```',
      diffText,
      '```',
      `> ${formatDuration(result.durationMs)} | $${result.cost.toFixed(4)}`,
      verificationSummary(state.verification!),
    ].join('\n'))

    state = await advanceState(state, 'creating_pr', {
      costUsd: costTracker.getTaskCost(issue.id),
      llmResponse: result.resultText,
    }, stateStore)
    await removeWorktree(worktree)
    return state
  } catch (err) {
    console.error(`[${agent.id}] workspace preserved: ${worktree.path}`)
    throw err
  }
}

// ── CTO review: native execution on worktree ────────────────────

export type NativeReviewDeps = {
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly addComment: (issueId: string, text: string) => Promise<void>
  readonly addPRComment: (prId: string, body: string) => Promise<void>
  readonly getPRDiff: (prId: string) => Promise<string>
  readonly project: ProjectConfig
  readonly maxReviewCycles: number
}

export async function runNativeReviewAgent(
  issue: Issue,
  reviewer: AgentDefinition,
  state: ExecutionState,
  deps: NativeReviewDeps,
): Promise<ExecutionState> {
  const { stateStore, costTracker, addComment, addPRComment } = deps

  state = await advanceState(state, 'reviewing', {}, stateStore)

  const worktree = await createWorktree(state.branchName!, deps.project.root)

  console.log(`[${reviewer.id}] native review on worktree: ${worktree.path}`)

  await addComment(issue.id, [
    `🔎 **${reviewer.name}** is reviewing the PR (native mode)...`,
    `> Model: \`${reviewer.llm.model}\` via ${reviewer.llm.provider}`,
    `> Review cycle: ${state.reviewCycle + 1}/${deps.maxReviewCycles}`,
    `> Engine checks: ${state.verification?.passed ? 'passed' : 'not recorded'}`,
  ].join('\n'))

  try {
    if (state.commitSha && worktree.initialSha !== state.commitSha) throw new Error('PR branch changed since implementation; refusing a stale review')
    await prepareWorkspace(worktree, deps.project)
    const reviewTree = await snapshotWorktree(worktree)
    let rolePrompt = ''
    try {
      const file = Bun.file(reviewer.promptTemplate)
      if (await file.exists()) rolePrompt = await file.text()
    } catch {}
    if (!rolePrompt) rolePrompt = 'You are a code reviewer.'

    const diff = await deps.getPRDiff(state.prId!)

    const prompt = [
      rolePrompt,
      '',
      '## Project',
      `Project: ${deps.project.name}`,
      '',
      '## Task Being Reviewed',
      `**${issue.title}**`,
      issue.body || '',
      '',
      '## PR Diff',
      '```diff',
      diff,
      '```',
      '',
      '## Instructions',
      'You are on the branch with the agent\'s changes. Please:',
      '1. Inspect the implementation and related tests; do not edit, commit, or push.',
      state.verification ? verificationSummary(state.verification) : 'No engine verification recorded. Do not claim tests passed.',
      '2. Review the code for correctness, security, style, and documentation',
      '3. At the end, output your verdict as a JSON block:',
      '```json',
      '{ "decision": "approve" or "request_changes", "comments": "your review" }',
      '```',
      'Only approve if the code is correct. Test claims must match the engine results above.',
    ].join('\n')

    const result = await spawnClaudeCode(
      prompt,
      worktree.path,
      reviewer.llm.model,
    )

    costTracker.recordCost(issue.id, result.cost)
    console.log(`[${reviewer.id}] native review: ${formatDuration(result.durationMs)}, $${result.cost.toFixed(4)}, exit ${result.exitCode}`)

    // Extract verdict from the response. Fail closed: default to request_changes
    // so a missing/unparseable verdict never counts as an approval.
    let verdict: ReviewVerdict = {
      decision: 'request_changes',
      comments: 'No review verdict could be parsed from the reviewer output — failing closed.',
    }

    const jsonMatch = result.resultText.match(/```json\s*([\s\S]*?)```/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]!)
        if (parsed.decision === 'approve' || parsed.decision === 'request_changes') {
          verdict = { decision: parsed.decision, comments: parsed.comments ?? '' }
        }
      } catch {}
    }

    // Also try to parse the whole response if no json block found
    if (!jsonMatch) {
      try {
        const parsed = JSON.parse(result.resultText)
        if (parsed.decision === 'approve' || parsed.decision === 'request_changes') {
          verdict = { decision: parsed.decision, comments: parsed.comments ?? '' }
        }
      } catch {}
    }

    // A crashed or timed-out reviewer must never count as an approval.
    // exit 143 represents the runner deadline; any nonzero exit is a failure.
    if (result.exitCode !== 0 || reviewTree !== await snapshotWorktree(worktree)) {
      verdict = {
        decision: 'request_changes',
        comments: result.exitCode === 143
          ? 'Reviewer timed out before producing a verdict — failing closed.'
          : 'Reviewer failed or modified the workspace — failing closed.',
      }
    }

    console.log(`[${reviewer.id}] verdict: ${verdict.decision}`)

    // Post review as PR comment
    await addPRComment(
      state.prId!,
      [
        `## ${reviewer.name} Review (cycle ${state.reviewCycle + 1})`,
        '',
        `**Verdict:** ${verdict.decision === 'approve' ? '✅ Approved' : '🔄 Changes Requested'}`,
        '',
        verdict.comments,
        '',
        `*Model: ${reviewer.llm.model} | ${formatDuration(result.durationMs)} | $${result.cost.toFixed(4)}*`,
      ].join('\n'),
    )

    if (verdict.decision === 'approve') {
      await addComment(issue.id, [
        `✅ **${reviewer.name}** approved the PR`,
        '',
        `> ${verdict.comments.length > 200 ? verdict.comments.slice(0, 200) + '...' : verdict.comments}`,
      ].join('\n'))
    } else {
      await addComment(issue.id, [
        `🔄 **${reviewer.name}** requested changes (cycle ${state.reviewCycle + 1}/${deps.maxReviewCycles})`,
        '',
        `> ${verdict.comments.length > 300 ? verdict.comments.slice(0, 300) + '...' : verdict.comments}`,
      ].join('\n'))
    }

    return advanceState(state, verdict.decision === 'approve' ? 'updating_issue' : 'revision', {
      reviewVerdict: verdict,
      reviewCycle: state.reviewCycle + 1,
      costUsd: costTracker.getTaskCost(issue.id),
    }, stateStore)
  } finally {
    await removeWorktree(worktree)
  }
}
