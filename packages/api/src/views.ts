/**
 * From the engine's records to what the API says. Pure: a state in, a view out.
 */

import type { AgentDefinition, Attempt, ExecutionState, Issue, ReviewRecord } from '@floor-agents/core'
import type {
  ApiAgent, ApiAttempt, ApiAttemptSummary, ApiIssue, ApiReview, ApiReviewSummary, ApiRunDetail, ApiRunSummary, RunPhase,
} from './types.ts'

export function agentView(agent: AgentDefinition & { readonly external?: boolean }): ApiAgent {
  const caps = agent.capabilities as readonly string[]
  const role: ApiAgent['role'] = caps.includes('write_code') ? 'implementer'
    : caps.includes('vote') ? 'committee member'
    : caps.includes('review_pr') || caps.includes('review_rfc') ? 'reviewer'
    : caps.includes('decompose') || caps.includes('plan') ? 'planner'
    : 'member'
  return {
    id: agent.id, name: agent.name, role,
    provider: agent.llm.provider, model: agent.llm.model,
    external: Boolean(agent.external), capabilities: [...caps],
  }
}

/** Where a run stands, at a glance. */
export function phaseOf(state: ExecutionState): RunPhase {
  const lastReview = state.reviews?.at(-1)
  const lastAttempt = state.attempts?.at(-1)
  if (state.step === 'done') return lastReview?.outcome === 'no_decision' ? 'needs-person' : 'done'
  if (state.step === 'failed') {
    const forPerson = Boolean(lastReview?.standing?.length) || /needs (a )?(human|person)|max review cycles/i.test(state.error ?? '')
    return forPerson ? 'needs-person' : 'failed'
  }
  if (state.step === 'reviewing') return 'reviewing'
  if (state.step === 'revision') return 'revising'
  // The turn has ended and its tree is at the gate.
  if (lastAttempt?.outcome === 'running' && lastAttempt.turnMs !== undefined) return 'verifying'
  if (lastAttempt?.outcome === 'running' && lastAttempt.kind === 'revision') return 'revising'
  return 'working'
}

function attemptSummary(a: Attempt): ApiAttemptSummary {
  const gate = a.gates.at(-1)
  return {
    n: a.n, kind: a.kind, agentId: a.agentId, model: a.model, outcome: a.outcome,
    turnMs: a.turnMs ?? null,
    gate: !gate ? 'none' : gate.passed ? 'passed' : 'failed',
    gateMs: gate?.durationMs ?? null,
    continues: a.continues ?? null,
    commit: a.commitSha ?? null,
    startedAt: a.startedAt, endedAt: a.endedAt ?? null,
  }
}

function reviewSummary(r: ReviewRecord): ApiReviewSummary {
  return {
    cycle: r.cycle, outcome: r.outcome, durationMs: r.durationMs, at: r.at,
    votes: r.votes.map(v => ({ agent: v.agentName, vote: v.vote, failed: v.execution === 'failed' })),
  }
}

export function runSummary(state: ExecutionState): ApiRunSummary {
  const attempts = state.attempts ?? []
  const reviews = state.reviews ?? []
  const workMs = attempts.reduce((sum, a) => sum + (a.turnMs ?? 0) + a.gates.reduce((g, run) => g + run.durationMs, 0), 0)
    + reviews.reduce((sum, r) => sum + r.durationMs, 0)
  return {
    issueId: state.issueId,
    issueKey: state.issueKey ?? null,
    issueTitle: state.issueTitle ?? null,
    step: state.step,
    phase: phaseOf(state),
    error: state.error ? state.error.split('\n')[0]!.slice(0, 300) : null,
    agentId: state.agentId,
    branch: state.branchName,
    prUrl: state.prUrl,
    attempts: attempts.length,
    lastAttempt: attempts.length ? attemptSummary(attempts.at(-1)!) : null,
    reviews: reviews.length,
    lastReview: reviews.length ? reviewSummary(reviews.at(-1)!) : null,
    costUsd: state.costUsd,
    workMs,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  }
}

function attemptView(a: Attempt): ApiAttempt {
  return {
    ...attemptSummary(a),
    reply: a.reply ?? null,
    error: a.error ?? null,
    worktreePath: a.worktreePath ?? null,
    gates: a.gates.map(g => ({
      at: g.at, passed: g.passed, durationMs: g.durationMs, error: g.error ?? null,
      checks: g.checks.map(c => ({
        name: c.name, passed: c.exitCode === 0 && !c.timedOut, timedOut: c.timedOut, durationMs: c.durationMs, tail: c.tail ?? null,
      })),
    })),
  }
}

function reviewView(r: ReviewRecord): ApiReview {
  return { ...reviewSummary(r), commit: r.commitSha, blockers: r.blockers ?? null, standing: [...(r.standing ?? [])] }
}

/** The whole history of one run. The agent's raw output and the parsed files are not part of it. */
export function runDetail(state: ExecutionState): ApiRunDetail {
  return {
    ...runSummary(state),
    attemptList: (state.attempts ?? []).map(attemptView),
    reviewList: (state.reviews ?? []).map(reviewView),
  }
}

/**
 * Whether a recorded run is this project's. A state directory may be shared by
 * several projects: newer runs name their repository; older ones are recognised
 * by their pull request, or by belonging to an issue the project lists.
 */
export function belongsTo(state: ExecutionState, repo: string, issueIds: ReadonlySet<string>): boolean {
  if (state.repo) return state.repo === repo
  if (state.prUrl) return state.prUrl.includes(`/${repo}/`)
  return issueIds.has(state.issueId)
}

export function issueView(issue: Issue, run: ExecutionState | undefined, triggerLabels: readonly string[]): ApiIssue {
  const wanted = new Set(triggerLabels.map(l => l.toLowerCase()))
  return {
    id: issue.id,
    key: issue.key ?? null,
    title: issue.title,
    status: issue.status,
    stateName: issue.stateName ?? null,
    milestone: issue.milestone ?? null,
    priority: issue.priority ?? null,
    labels: [...issue.labels],
    url: issue.url ?? null,
    queued: issue.labels.some(l => wanted.has(l.toLowerCase())),
    updatedAt: issue.updatedAt.toISOString(),
    run: run ? runSummary(run) : null,
  }
}

/** An issue the task source could not give us, rebuilt from what its run recorded. */
export function issueFromRun(state: ExecutionState): ApiIssue {
  return {
    id: state.issueId, key: state.issueKey ?? null, title: state.issueTitle ?? state.branchName ?? state.issueId,
    status: 'unknown', stateName: null, milestone: null, priority: null, labels: [], url: null, queued: true,
    updatedAt: state.updatedAt, run: runSummary(state),
  }
}
