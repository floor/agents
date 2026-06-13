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
  {
    name: 'create_issue',
    description: 'Create a follow-up issue in the project tracker. Use for tasks discovered during review.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, actionable issue title' },
        description: { type: 'string', description: 'Full description with context and acceptance criteria' },
        priority: { type: 'number', enum: [1, 2, 3, 4], description: '1=urgent, 2=high, 3=medium, 4=low' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels (e.g. "backend", "agent")' },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to the current issue.',
    inputSchema: {
      type: 'object',
      properties: {
        comment: { type: 'string', description: 'Comment text (markdown)' },
      },
      required: ['comment'],
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
    'You can also use `create_issue` to create follow-up tasks and `add_comment` to post to the issue.',
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

  // Process create_issue and add_comment tool calls
  for (const tc of result.toolCalls) {
    if (tc.name === 'create_issue') {
      const { title, description, labels } = tc.input as {
        title: string
        description: string
        labels?: string[]
      }
      const created = await taskAdapter.createIssue({
        title,
        body: description,
        labels: labels ?? [],
        status: 'backlog',
      }, issue.id)
      console.log(`[${reviewer.id}] created issue: ${created.id} "${title}"`)
    } else if (tc.name === 'add_comment') {
      const { comment } = tc.input as { comment: string }
      await taskAdapter.addComment(issue.id, comment)
      console.log(`[${reviewer.id}] added comment to ${issue.id}`)
    }
  }

  const verdictCall = result.toolCalls.find(tc => tc.name === 'review_verdict')
  const verdict: ReviewVerdict = verdictCall
    ? { decision: verdictCall.input.decision as 'approve' | 'request_changes', comments: verdictCall.input.comments as string }
    : { decision: 'request_changes', comments: 'No review verdict was returned — failing closed.' }

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
