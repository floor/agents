import type {
  CompanyConfig,
  GitAdapter,
  TaskAdapter,
  Issue,
  ExecutionState,
  ExecutionStep,
  StateStore,
  AgentDefinition,
  ToolDefinition,
  ReviewVerdict,
} from '@floor-agents/core'
import { runToolUseLoop, type LLMAdapterResolver } from './llm-runner.ts'
import type { CostTracker } from './cost-tracker.ts'

export const MAX_REVIEW_CYCLES = 3

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

export type ReviewDeps = {
  readonly company: CompanyConfig
  readonly gitAdapter: GitAdapter
  readonly taskAdapter: TaskAdapter
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly getAdapter: LLMAdapterResolver
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

export async function runReviewAgent(
  issue: Issue,
  reviewer: AgentDefinition,
  state: ExecutionState,
  deps: ReviewDeps,
): Promise<ExecutionState> {
  const { company, gitAdapter, taskAdapter, stateStore, costTracker, getAdapter } = deps

  state = await advanceState(state, 'reviewing', {}, stateStore)

  const diff = await gitAdapter.getPRDiff(company.project.repo, state.prId!)
  console.log(`[${reviewer.id}] reviewing PR (${diff.length} chars of diff)...`)

  await taskAdapter.addComment(issue.id, [
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

  const result = await runToolUseLoop(reviewer, systemPrompt, [{ role: 'user', content: userMessage }], REVIEW_TOOLS, getAdapter)
  costTracker.recordCost(issue.id, result.totalCost)
  console.log(`[${reviewer.id}] LLM: ${result.totalInputTokens} in, ${result.totalOutputTokens} out, $${result.totalCost.toFixed(4)}`)

  const verdictCall = result.toolCalls.find(tc => tc.name === 'review_verdict')
  const verdict: ReviewVerdict = verdictCall
    ? { decision: verdictCall.input.decision as 'approve' | 'request_changes', comments: verdictCall.input.comments as string }
    : { decision: 'approve', comments: result.content || 'No specific feedback.' }

  console.log(`[${reviewer.id}] verdict: ${verdict.decision}`)

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

  if (verdict.decision === 'approve') {
    await taskAdapter.addComment(issue.id, [
      `✅ **${reviewer.name}** approved the PR`,
      '',
      `> ${verdict.comments.length > 200 ? verdict.comments.slice(0, 200) + '...' : verdict.comments}`,
    ].join('\n'))
  } else {
    await taskAdapter.addComment(issue.id, [
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
