import type {
  CompanyConfig,
  TaskAdapter,
  Issue,
  AgentDefinition,
  StateStore,
  LLMMessage,
  IssueComment,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import { runToolUseLoop, type LLMAdapterResolver } from './llm-runner.ts'
import type { CostTracker } from './cost-tracker.ts'
import type { DiscussionsAdapter } from '@floor-agents/github'
import type { Gateway } from '@floor-agents/gateway'
import { sign, signComments, agentSignature, ENGINE_SIGNATURE } from './comment-signature.ts'
import { costNote } from './cost-note.ts'
import { extractVote, type Vote } from './vote.ts'

// ── Types ────────────────────────────────────────────────────────

export type { Vote } from './vote.ts'

/**
 * How a committee member produced its vote.
 *
 * `answered` is a completed review — including one whose `VOTE:` marker was
 * not recognised, which still abstains but may carry `BLOCKER:` lines.
 * `failed` is an execution that never finished (timeout, adapter error,
 * bridge failure); its text is not a review, so `BLOCKER:` inside an error
 * must not count.
 */
export type CommitteeVoteExecution = 'answered' | 'failed'

export type CommitteeVote = {
  readonly agentId: string
  readonly agentName: string
  readonly vote: Vote
  readonly summary: string
  readonly response: string
  readonly costUsd: number
  readonly execution: CommitteeVoteExecution
}

export type CommitteeResult = {
  readonly issueId: string
  readonly votes: readonly CommitteeVote[]
  readonly outcome: 'approved' | 'rejected' | 'no_quorum'
  readonly totalCost: number
}

export type ExternalAgentConfig = {
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
}

export type ExternalVoterStart =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

export type ExternalVoterSession = {
  readonly gateway?: Gateway
  readonly started: ReadonlyMap<string, ExternalVoterStart>
  stop(): void
}

/**
 * Starts (or reuses) a gateway and a bridge process for each external voter
 * for the duration of one review. Injected so tests can fake the processes
 * and so `run` / `watch` / `committee-run` share the same lifecycle.
 */
export type ExternalVoterHost = {
  start(agents: readonly AgentDefinition[]): Promise<ExternalVoterSession>
}

export type CommitteePipelineDeps = {
  readonly company: CompanyConfig
  readonly taskAdapter: TaskAdapter
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly getAdapter: LLMAdapterResolver
  readonly discussions?: DiscussionsAdapter
  readonly externalAgents?: ExternalAgentConfig
  readonly gateway?: Gateway
  readonly externalVoters?: ExternalVoterHost
}

// ── Vote extraction ──────────────────────────────────────────────

function tallyVotes(votes: readonly CommitteeVote[]): 'approved' | 'rejected' | 'no_quorum' {
  const cast = votes.filter(v => v.vote !== 'abstain')
  if (cast.length === 0) return 'no_quorum'

  const approvals = cast.filter(v => v.vote === 'approve').length
  // Strict majority: approvals must exceed half the cast votes, so a tie does
  // not approve (e.g. 1 approve / 1 reject → rejected).
  return approvals > cast.length / 2 ? 'approved' : 'rejected'
}

// ── Prompt assembly ─────────────────────────────────────────────

/**
 * Build an agent's system prompt from its persona template + project/agent
 * context. Used by both internal agents and external agents (gateway/MCP), so
 * Codex and Antigravity each review through their own lens rather than a shared
 * generic prompt.
 */
export async function buildSystemPrompt(agent: AgentDefinition, company: CompanyConfig): Promise<string> {
  const promptFile = Bun.file(agent.promptTemplate)
  const base = (await promptFile.exists())
    ? await promptFile.text()
    : `You are ${agent.name}, a technical committee member. Review the RFC and vote APPROVE or REJECT.`

  const projectContext = company.project.customInstructions
    ? `\n\n## Project Context\n${company.project.customInstructions}`
    : ''
  const agentContext = agent.customInstructions
    ? `\n\n## Agent-Specific Instructions\n${agent.customInstructions}`
    : ''

  return base + projectContext + agentContext
}

// ── Single agent review ──────────────────────────────────────────

function defaultProposalUserMessage(issue: Issue): string {
  return [
    `## Proposal for Review\n\n**${issue.title}**`,
    issue.body ? `\n${issue.body}` : '',
    '\n---',
    '\nPlease review this proposal against the current codebase.',
    'Provide your technical analysis and explicitly state **VOTE: APPROVE** or **VOTE: REJECT**.',
  ].join('\n')
}

export type CommitteeDispatchPrompt = {
  readonly userMessage: string
  /** Body sent to external agents on the gateway assignment. Defaults to the issue body. */
  readonly assignmentBody?: string
}

async function runCommitteeAgent(
  issue: Issue,
  agent: AgentDefinition,
  deps: CommitteePipelineDeps,
  userMessage: string,
): Promise<CommitteeVote> {
  const { company, costTracker, getAdapter } = deps

  console.log(`[committee] ${agent.id}: reviewing "${issue.title}"`)

  const systemPrompt = await buildSystemPrompt(agent, company)

  const messages: LLMMessage[] = [{
    role: 'user',
    content: userMessage,
  }]

  try {
    const result = await runToolUseLoop(
      agent,
      systemPrompt,
      messages,
      [],
      getAdapter,
    )

    costTracker.recordCost(issue.id, result.totalCost)
    const vote = extractVote(result.content)

    console.log(`[committee] ${agent.id}: ${vote} ($${result.totalCost.toFixed(4)}, ${result.durationMs}ms)`)

    return {
      agentId: agent.id,
      agentName: agent.name,
      vote,
      summary: result.content.slice(0, 500),
      response: result.content,
      costUsd: result.totalCost,
      execution: 'answered',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[committee] ${agent.id}: error — ${message}`)

    return {
      agentId: agent.id,
      agentName: agent.name,
      vote: 'abstain',
      summary: `Error: ${message}`,
      response: '',
      costUsd: 0,
      execution: 'failed',
    }
  }
}

// ── External agent dispatch via gateway ─────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 15_000
const DEFAULT_EXTERNAL_TIMEOUT_MS = 5 * 60_000

function abstainVote(agent: AgentDefinition, summary: string): CommitteeVote {
  return {
    agentId: agent.id,
    agentName: agent.name,
    vote: 'abstain',
    summary,
    response: summary,
    costUsd: 0,
    execution: 'failed',
  }
}

async function dispatchExternalAgent(
  issue: Issue,
  agent: AgentDefinition,
  deps: CommitteePipelineDeps,
  systemPrompt: string,
  assignmentBody: string,
): Promise<CommitteeVote> {
  const { gateway } = deps
  const config = deps.externalAgents ?? {}
  const timeout = config.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS

  if (!gateway) {
    return abstainVote(
      agent,
      'No gateway: external voter needs a bridge, or voteByComment: true to poll issue comments',
    )
  }

  const taskId = `${issue.id}:${agent.id}`
  console.log(`[committee] ${agent.id}: dispatching via gateway (timeout ${timeout / 1000}s)`)

  // Register the pending-result handler BEFORE assigning, so a fast external
  // agent that responds in the window between assign and await cannot have its
  // result dropped (which would surface as a false timeout).
  const resultP = gateway.waitForResult(taskId, timeout)
  gateway.assign(agent.id, {
    id: taskId,
    issueId: issue.id,
    title: issue.title,
    body: assignmentBody,
    systemPrompt,
    createdAt: new Date().toISOString(),
  })

  try {
    const result = await resultP
    if (result.failed) {
      // The bridge answered, but only to say its CLI failed. That is not a
      // member abstaining: it is a seat that did not review, and the reason
      // (quota, login, crash) is what a person needs to read on the PR.
      console.log(`[committee] ${agent.id}: bridge reported a failure — ${result.content.split('\n')[0]}`)
      return abstainVote(agent, result.content)
    }
    const vote = extractVote(result.content)
    console.log(`[committee] ${agent.id}: gateway vote received — ${vote}`)

    return {
      agentId: agent.id,
      agentName: agent.name,
      vote,
      summary: result.content.slice(0, 500),
      response: result.content,
      costUsd: 0,
      execution: 'answered',
    }
  } catch {
    console.log(`[committee] ${agent.id}: gateway vote timed out`)
    return abstainVote(agent, 'External agent timed out')
  }
}

async function voteForExternalAgent(
  issue: Issue,
  agent: AgentDefinition,
  deps: CommitteePipelineDeps,
  systemPrompt: string,
  assignmentBody: string,
  session: ExternalVoterSession | undefined,
): Promise<CommitteeVote> {
  if (agent.voteByComment) {
    return pollForExternalVote(issue, agent, deps)
  }

  const start = session?.started.get(agent.id)
  if (start && !start.ok) {
    console.log(`[committee] ${agent.id}: bridge failed — ${start.reason}`)
    return abstainVote(agent, `Bridge failed to start: ${start.reason}`)
  }

  const gateway = session?.gateway ?? deps.gateway
  if (!gateway) {
    console.log(`[committee] ${agent.id}: no gateway — abstaining (set voteByComment to poll issue comments)`)
    return abstainVote(
      agent,
      'No gateway: external voter needs a bridge, or voteByComment: true to poll issue comments',
    )
  }

  return dispatchExternalAgent(issue, agent, { ...deps, gateway }, systemPrompt, assignmentBody)
}

async function startVoterSession(
  agents: readonly AgentDefinition[],
  deps: CommitteePipelineDeps,
): Promise<ExternalVoterSession | undefined> {
  if (!agents.length || !deps.externalVoters) return undefined
  try {
    return await deps.externalVoters.start(agents)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[committee] failed to start external voters: ${reason}`)
    return {
      ...(deps.gateway ? { gateway: deps.gateway } : {}),
      started: new Map(agents.map(a => [a.id, { ok: false as const, reason }])),
      stop() {},
    }
  }
}

/**
 * Run every member in parallel and collect votes. Used by RFC review and by
 * the PR-review path, which supplies a prompt that includes the diff.
 *
 * External members get a bridge for the duration of this call (when an
 * {@link ExternalVoterHost} is provided). A bridge that cannot start abstains
 * immediately. Comment polling runs only for members with `voteByComment`.
 */
export async function collectCommitteeVotes(
  issue: Issue,
  agents: readonly AgentDefinition[],
  deps: CommitteePipelineDeps,
  prompt?: CommitteeDispatchPrompt,
): Promise<CommitteeVote[]> {
  const { company } = deps
  const internalAgents = agents.filter(a => !a.external)
  const commentVoters = agents.filter(a => a.external && a.voteByComment)
  const bridgeVoters = agents.filter(a => a.external && !a.voteByComment)
  const userMessage = prompt?.userMessage ?? defaultProposalUserMessage(issue)
  const assignmentBody = prompt?.assignmentBody ?? issue.body

  const session = await startVoterSession(bridgeVoters, deps)
  try {
    return await Promise.all([
      ...internalAgents.map(agent => runCommitteeAgent(issue, agent, deps, userMessage)),
      ...commentVoters.map(async agent =>
        voteForExternalAgent(issue, agent, deps, await buildSystemPrompt(agent, company), assignmentBody, session)),
      ...bridgeVoters.map(async agent =>
        voteForExternalAgent(issue, agent, deps, await buildSystemPrompt(agent, company), assignmentBody, session)),
    ])
  } finally {
    session?.stop()
  }
}

async function pollForExternalVote(
  issue: Issue,
  agent: AgentDefinition,
  deps: CommitteePipelineDeps,
): Promise<CommitteeVote> {
  const { taskAdapter } = deps
  const config = deps.externalAgents ?? {}
  const pollInterval = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeout = config.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS
  const afterTimestamp = new Date()

  if (!taskAdapter.getComments) {
    console.error(`[committee] ${agent.id}: no gateway and no getComments — cannot dispatch`)
    return { agentId: agent.id, agentName: agent.name, vote: 'abstain', summary: 'No gateway or getComments available', response: '', costUsd: 0, execution: 'failed' }
  }

  console.log(`[committee] ${agent.id}: polling for external vote (timeout ${timeout / 1000}s)`)

  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    const comments = await taskAdapter.getComments(issue.id)

    for (const comment of comments) {
      if (comment.createdAt <= afterTimestamp) continue

      const vote = extractVote(comment.body)
      if (vote === 'abstain') continue

      const matchesAgent = comment.body.toUpperCase().includes(agent.id.toUpperCase())
        || comment.author.toUpperCase().includes(agent.id.toUpperCase())
        || comment.author.toUpperCase().includes(agent.name.toUpperCase())

      if (matchesAgent) {
        console.log(`[committee] ${agent.id}: external vote received — ${vote}`)
        return {
          agentId: agent.id,
          agentName: agent.name,
          vote,
          summary: comment.body.slice(0, 500),
          response: comment.body,
          costUsd: 0,
          execution: 'answered',
        }
      }
    }

    await new Promise(r => setTimeout(r, pollInterval))
  }

  console.log(`[committee] ${agent.id}: external vote timed out`)
  return { agentId: agent.id, agentName: agent.name, vote: 'abstain', summary: 'External agent timed out', response: '', costUsd: 0, execution: 'failed' }
}

// ── Main committee pipeline ──────────────────────────────────────

export async function executeCommitteeReview(
  issue: Issue,
  agents: readonly AgentDefinition[],
  deps: CommitteePipelineDeps,
): Promise<CommitteeResult> {
  const { taskAdapter: unsigned, costTracker, company } = deps
  // The committee's own turns are the engine speaking; a member's review is
  // signed with that member, so the account's name is not the only attribution.
  const taskAdapter = signComments(unsigned, ENGINE_SIGNATURE)
  const startTime = performance.now()

  const internalAgents = agents.filter(a => !a.external)
  const externalAgents = agents.filter(a => a.external)

  console.log(`[committee] starting review: "${issue.title}" with ${internalAgents.length} internal + ${externalAgents.length} external agents`)

  const pollStart = new Date()

  await taskAdapter.addComment(issue.id, [
    '🏛️ **Committee Review Started**',
    '',
    '| Agent | Provider | Type |',
    '|-------|----------|------|',
    ...agents.map(a => `| ${a.name} | ${a.llm.provider} | ${a.external ? 'external' : 'internal'} |`),
    '',
    externalAgents.length > 0
      ? 'Internal agents are reviewing now. Waiting for external agents to post their votes.'
      : 'Agents are reviewing in parallel. Votes will be posted when all reviews complete.',
  ].join('\n'))

  // Run internal and external agents in parallel — each external agent gets its
  // own persona from its promptTemplate (codex-reviewer.md, antigravity-reviewer.md)
  // rather than a shared generic prompt.
  const votes = await collectCommitteeVotes(issue, agents, deps)

  const outcome = tallyVotes(votes)
  const totalCost = votes.reduce((sum, v) => sum + v.costUsd, 0)
  const duration = Math.round(performance.now() - startTime)

  // Post individual responses
  const byId = new Map(agents.map(a => [a.id, a]))
  for (const vote of votes) {
    if (vote.response) {
      const voter = byId.get(vote.agentId)
      await unsigned.addComment(issue.id, sign(vote.response, voter ? agentSignature(voter, 'committee member') : ENGINE_SIGNATURE))
    }
  }

  // Post vote tally
  const tallyComment = [
    '## 🗳️ Vote Results',
    '',
    '| Agent | Vote |',
    '|-------|------|',
    ...votes.map(v => `| ${v.agentName} | **${v.vote.toUpperCase()}** |`),
    '',
    `**Outcome: ${outcome.toUpperCase()}**`,
    '',
    `> Duration: ${duration < 60_000 ? `${(duration / 1000).toFixed(1)}s` : `${Math.floor(duration / 60_000)}m ${Math.round((duration % 60_000) / 1000)}s`}`,
    costNote(totalCost) ? `> Total cost: ${costNote(totalCost)}` : '',
  ].filter(Boolean).join('\n')

  await taskAdapter.addComment(issue.id, tallyComment)

  // Update issue status based on outcome
  if (outcome === 'approved') {
    await taskAdapter.setStatus(issue.id, 'done')
    await taskAdapter.setLabel(issue.id, 'approved')
  } else if (outcome === 'rejected') {
    await taskAdapter.setLabel(issue.id, 'rejected')
  }

  // Sync to GitHub Discussions if configured
  if (deps.discussions) {
    await syncToDiscussions(issue, votes, outcome, deps.discussions)
  }

  console.log(`[committee] done: "${issue.title}" → ${outcome} ($${totalCost.toFixed(4)}, ${duration}ms)`)

  return { issueId: issue.id, votes, outcome, totalCost }
}

// ── GitHub Discussions sync ──────────────────────────────────────

async function syncToDiscussions(
  issue: Issue,
  votes: readonly CommitteeVote[],
  outcome: string,
  discussions: DiscussionsAdapter,
): Promise<void> {
  // Extract discussion number from issue body or labels
  const discNumberMatch = issue.body.match(/discussions\/(\d+)/)
    ?? issue.body.match(/Discussion #(\d+)/)
    ?? issue.body.match(/GH-D(\d+)/)

  if (!discNumberMatch) {
    console.log('[committee] no linked discussion found — skipping sync')
    return
  }

  const discNumber = parseInt(discNumberMatch[1]!, 10)

  try {
    const discussion = await discussions.getDiscussion(discNumber)
    if (!discussion) {
      console.error(`[committee] discussion #${discNumber} not found`)
      return
    }

    const body = [
      `## RFC Vote Resolution — ${issue.title}`,
      '',
      `**Result: ${outcome.toUpperCase()}**`,
      '',
      '| Agent | Vote |',
      '|-------|------|',
      ...votes.map(v => `| ${v.agentName} | **${v.vote.toUpperCase()}** |`),
      '',
      ...votes
        .filter(v => v.vote !== 'abstain' && v.summary)
        .map(v => `**${v.agentName}:** ${v.summary.slice(0, 200)}...`),
      '',
      '---',
      '_Synced from Linear by Floor Agents_',
    ].join('\n')

    await discussions.postComment(discussion.id, body)
    console.log(`[committee] synced to discussion #${discNumber}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[committee] sync failed: ${message}`)
  }
}
