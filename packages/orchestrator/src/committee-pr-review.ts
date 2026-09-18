/**
 * Committee review of an implementer's pull request.
 *
 * After the engine opens a PR, every agent with `vote` reviews the diff the
 * way the committee reviews an RFC: in parallel, inside each member's
 * reviewer sandbox (via its LLM adapter), returning findings and a vote.
 * The engine posts one signed PR comment per member and one summary.
 * Merging stays with the coordinator.
 */

import type {
  CompanyConfig,
  GitAdapter,
  TaskAdapter,
  Issue,
  ExecutionState,
  ExecutionStep,
  StateStore,
  AgentDefinition,
  ReviewVerdict,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import type { Gateway } from '@floor-agents/gateway'
import {
  collectCommitteeVotes,
  type CommitteePipelineDeps,
  type CommitteeVote,
} from './committee-pipeline.ts'
import type { CostTracker } from './cost-tracker.ts'
import { sign, agentSignature, ENGINE_SIGNATURE } from './comment-signature.ts'
import { costNote } from './cost-note.ts'
import { MAX_REVIEW_CYCLES } from './review.ts'

export type CommitteePrOutcome = 'approve' | 'request_changes' | 'no_decision'

export type CommitteePrReviewDeps = {
  readonly company: CompanyConfig
  readonly taskAdapter: TaskAdapter
  readonly gitAdapter: GitAdapter
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly getAdapter: CommitteePipelineDeps['getAdapter']
  readonly gateway?: Gateway
  readonly externalAgents?: CommitteePipelineDeps['externalAgents']
  readonly externalVoters?: CommitteePipelineDeps['externalVoters']
}

export function committeeVoters(agents: readonly AgentDefinition[]): AgentDefinition[] {
  return agents.filter(a => a.capabilities.includes('vote'))
}

/**
 * Whether `executeTask` should send the PR to the committee instead of a
 * single `review_pr` agent.
 *
 * `review.committee: true` in the manifest always opts in (when anyone can
 * vote). Absent that flag, committee review is the default only when the
 * manifest seats no `review_pr` agent — the single-reviewer path stays for
 * teams that already have one.
 */
export function committeePrReviewEnabled(company: Pick<CompanyConfig, 'agents' | 'review'>): boolean {
  if (!committeeVoters(company.agents).length) return false
  if (company.review?.committee !== undefined) return company.review.committee
  return !company.agents.some(a => a.capabilities.includes('review_pr') && !a.external)
}

export function extractBlockers(text: string): string[] {
  const found: string[] = []
  const re = /(?:^|\n)\s*\*{0,2}BLOCKER:\*{0,2}\s*(.+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const line = m[1]!.trim()
    if (line) found.push(line)
  }
  return found
}

function memberBlockers(vote: CommitteeVote): string[] {
  const listed = extractBlockers(vote.response || vote.summary)
  if (listed.length) return listed
  if (vote.vote === 'reject') {
    const text = (vote.summary || vote.response).trim()
    return text ? [text] : [`${vote.agentName} voted REJECT`]
  }
  return []
}

export function tallyCommitteePrReview(votes: readonly CommitteeVote[]): {
  readonly outcome: CommitteePrOutcome
  readonly reviewComments: string
} {
  const answers = votes.filter(v => v.vote !== 'abstain')
  if (answers.length < 2) {
    return { outcome: 'no_decision', reviewComments: '' }
  }

  const blockerNotes: string[] = []
  for (const v of votes) {
    const blockers = memberBlockers(v)
    if (!blockers.length) continue
    blockerNotes.push(`**${v.agentName}:**\n${blockers.join('\n')}`)
  }

  const approvals = answers.filter(v => v.vote === 'approve').length
  const majority = approvals > answers.length / 2
  if (majority && blockerNotes.length === 0) {
    return { outcome: 'approve', reviewComments: answers.map(v => v.summary).filter(Boolean).join('\n\n') }
  }
  return { outcome: 'request_changes', reviewComments: blockerNotes.join('\n\n') }
}

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

function prReviewUserMessage(issue: Issue, diff: string): string {
  return [
    `## Pull Request for Review\n\n**${issue.title}**`,
    issue.body ? `\n${issue.body}` : '',
    '\n## PR Diff',
    '```diff',
    diff,
    '```',
    '\n---',
    '\nReview this diff against the current codebase. You are a reviewer: report findings, do not edit.',
    'List every must-fix issue as **BLOCKER: <what must change>**.',
    'Provide your technical analysis and explicitly state **VOTE: APPROVE** or **VOTE: REJECT**.',
    'Approve only if the change is correct and you found no blockers.',
  ].join('\n')
}

export async function executeCommitteePrReview(
  issue: Issue,
  state: ExecutionState,
  deps: CommitteePrReviewDeps,
): Promise<ExecutionState> {
  const { company, taskAdapter, gitAdapter, stateStore, costTracker } = deps
  const voters = committeeVoters(company.agents)
  const startTime = performance.now()

  state = await advanceState(state, 'reviewing', {}, stateStore)

  const diff = await gitAdapter.getPRDiff(company.project.repo, state.prId!)
  const userMessage = prReviewUserMessage(issue, diff)

  console.log(`[committee] PR review: "${issue.title}" with ${voters.length} members (${diff.length} chars of diff)`)

  const votes = await collectCommitteeVotes(issue, voters, {
    company,
    taskAdapter,
    contextBuilder: deps.contextBuilder,
    stateStore,
    costTracker,
    getAdapter: deps.getAdapter,
    ...(deps.gateway ? { gateway: deps.gateway } : {}),
    ...(deps.externalAgents ? { externalAgents: deps.externalAgents } : {}),
    ...(deps.externalVoters ? { externalVoters: deps.externalVoters } : {}),
  }, { userMessage, assignmentBody: userMessage })

  const { outcome, reviewComments } = tallyCommitteePrReview(votes)
  const totalCost = votes.reduce((sum, v) => sum + v.costUsd, 0)
  const duration = Math.round(performance.now() - startTime)
  const cycle = state.reviewCycle + 1

  const byId = new Map(voters.map(a => [a.id, a]))
  for (const vote of votes) {
    const voter = byId.get(vote.agentId)
    const body = [
      `## ${vote.agentName} Review (cycle ${cycle})`,
      '',
      vote.response || vote.summary,
      '',
      `**Vote:** ${vote.vote.toUpperCase()}`,
    ].join('\n')
    await gitAdapter.addPRComment(
      company.project.repo,
      state.prId!,
      sign(body, voter ? agentSignature(voter, 'committee member') : ENGINE_SIGNATURE),
    )
  }

  const outcomeLabel = outcome === 'approve' ? 'APPROVED'
    : outcome === 'request_changes' ? 'CHANGES REQUESTED'
    : 'NO DECISION'

  const summary = [
    `## 🗳️ Committee PR Review (cycle ${cycle}/${MAX_REVIEW_CYCLES})`,
    '',
    '| Agent | Vote |',
    '|-------|------|',
    ...votes.map(v => `| ${v.agentName} | **${v.vote.toUpperCase()}** |`),
    '',
    `**Outcome: ${outcomeLabel}**`,
    outcome === 'no_decision'
      ? '\nFewer than two members returned a vote. Left for human review — the committee did not decide.'
      : '',
    outcome === 'request_changes' && reviewComments ? `\n### Blockers\n\n${reviewComments}` : '',
    '',
    `> Duration: ${formatDuration(duration)}`,
    costNote(totalCost) ? `> Total cost: ${costNote(totalCost)}` : '',
  ].filter(Boolean).join('\n')

  const signedSummary = sign(summary, ENGINE_SIGNATURE)
  await gitAdapter.addPRComment(company.project.repo, state.prId!, signedSummary)
  await taskAdapter.addComment(issue.id, signedSummary)

  if (outcome === 'no_decision') {
    await taskAdapter.setStatus(issue.id, 'in_review')
    return advanceState(state, 'updating_issue', {
      reviewVerdict: null,
      costUsd: costTracker.getTaskCost(issue.id),
    }, stateStore)
  }

  const verdict: ReviewVerdict = {
    decision: outcome === 'approve' ? 'approve' : 'request_changes',
    comments: reviewComments,
  }

  return advanceState(state, outcome === 'approve' ? 'updating_issue' : 'revision', {
    reviewVerdict: verdict,
    reviewCycle: cycle,
    costUsd: costTracker.getTaskCost(issue.id),
  }, stateStore)
}
