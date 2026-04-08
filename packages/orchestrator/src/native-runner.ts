import type {
  Issue,
  ExecutionState,
  ExecutionStep,
  StateStore,
  AgentDefinition,
  ReviewVerdict,
  ProjectConfig,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import { createWorktree, commitAndPushWorktree, removeWorktree, type Worktree } from './worktree.ts'
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

  // TODO: Use setup-token for Max plan auth instead of ANTHROPIC_API_KEY.
  // Currently passing the full env including API key — this bills per-token.
  // Run `claude setup-token` to configure long-lived Max plan auth, then
  // we can strip ANTHROPIC_API_KEY here.
  const proc = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CLAUDE_CODE_SKIP_HOOKS: '1' },
  })

  const timeout = setTimeout(() => proc.kill(), timeoutMs)
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
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

  return { resultText, cost, durationMs, exitCode }
}

// ── Dev agent: native execution on worktree ─────────────────────

export type NativeAgentDeps = {
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly addComment: (issueId: string, text: string) => Promise<void>
  readonly setLabel: (issueId: string, label: string) => Promise<void>
  readonly project: ProjectConfig
}

export async function runNativeDevAgent(
  issue: Issue,
  agent: AgentDefinition,
  state: ExecutionState,
  deps: NativeAgentDeps,
  reviewComments?: string,
): Promise<ExecutionState> {
  const { contextBuilder, stateStore, costTracker, addComment } = deps

  state = await advanceState(state, 'calling_llm', {}, stateStore)

  const worktree = await createWorktree(state.branchName!)
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
    // Build context hints
    const ctx = await contextBuilder.build({
      agent,
      issue,
      project: deps.project,
      reviewComments,
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
      'Run `bun run typecheck` and `bun test` before finishing to make sure everything passes.',
      'Do NOT use write_file or pr_description tools — edit files directly.',
    )

    const result = await spawnClaudeCode(
      promptParts.join('\n'),
      worktree.path,
      agent.llm.model,
    )

    costTracker.recordCost(issue.id, result.cost)
    console.log(`[${agent.id}] native agent: ${formatDuration(result.durationMs)}, $${result.cost.toFixed(4)}, exit ${result.exitCode}`)

    if (result.exitCode !== 0 && result.exitCode !== 143) {
      throw new Error(`Claude Code failed (exit ${result.exitCode}): ${result.resultText.slice(0, 500)}`)
    }

    const sha = await commitAndPushWorktree(
      worktree,
      `${issue.title}\n\nAutomated by Floor Agents (${agent.name})\nTask: ${issue.id}\nReview cycle: ${state.reviewCycle}`,
    )

    if (!sha) {
      await addComment(issue.id, `❌ **${agent.name}** made no changes to the code.`)
      await deps.setLabel(issue.id, 'needs-human')
      return advanceState(state, 'failed', {
        error: 'Native agent made no changes',
        llmResponse: result.resultText,
        costUsd: costTracker.getTaskCost(issue.id),
      }, stateStore)
    }

    const diffStat = await Bun.$`git -C ${worktree.path} diff HEAD~1 --stat`.quiet()
    const diffText = diffStat.stdout.toString().trim()

    await addComment(issue.id, [
      `✅ **${agent.name}** completed work (native mode):`,
      '```',
      diffText,
      '```',
      `> ${formatDuration(result.durationMs)} | $${result.cost.toFixed(4)}`,
    ].join('\n'))

    return advanceState(state, 'creating_pr', {
      commitSha: sha,
      costUsd: costTracker.getTaskCost(issue.id),
      llmResponse: result.resultText,
    }, stateStore)
  } finally {
    await removeWorktree(worktree)
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

  const worktree = await createWorktree(state.branchName!)

  console.log(`[${reviewer.id}] native review on worktree: ${worktree.path}`)

  await addComment(issue.id, [
    `🔎 **${reviewer.name}** is reviewing the PR (native mode)...`,
    `> Model: \`${reviewer.llm.model}\` via ${reviewer.llm.provider}`,
    `> Review cycle: ${state.reviewCycle + 1}/${deps.maxReviewCycles}`,
    `> Will run \`bun run typecheck\` and \`bun test\``,
  ].join('\n'))

  try {
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
      '1. Run `bun run typecheck` — report the result',
      '2. Run `bun test` — report the result',
      '3. Review the code for correctness, security, style, and documentation',
      '4. At the end, output your verdict as a JSON block:',
      '```json',
      '{ "decision": "approve" or "request_changes", "comments": "your review" }',
      '```',
      'Only approve if typecheck AND tests pass AND the code is correct.',
    ].join('\n')

    const result = await spawnClaudeCode(
      prompt,
      worktree.path,
      reviewer.llm.model,
    )

    costTracker.recordCost(issue.id, result.cost)
    console.log(`[${reviewer.id}] native review: ${formatDuration(result.durationMs)}, $${result.cost.toFixed(4)}, exit ${result.exitCode}`)

    // Extract verdict from the response
    let verdict: ReviewVerdict = { decision: 'approve', comments: result.resultText || 'No specific feedback.' }

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
        `*Model: ${reviewer.llm.model} | ${formatDuration(result.durationMs)} | $${result.cost.toFixed(4)} | typecheck + tests run on branch*`,
      ].join('\n'),
    )

    if (verdict.decision === 'approve') {
      await addComment(issue.id, [
        `✅ **${reviewer.name}** approved the PR (typecheck + tests verified)`,
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
