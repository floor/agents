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

// ── Types ────────────────────────────────────────────────────────

export type Vote = 'approve' | 'reject' | 'abstain'

export type CommitteeVote = {
  readonly agentId: string
  readonly agentName: string
  readonly vote: Vote
  readonly summary: string
  readonly response: string
  readonly costUsd: number
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
}

// ── Vote extraction ──────────────────────────────────────────────

function extractVote(response: string): Vote {
  const upper = response.toUpperCase()
  if (upper.includes('VOTE: APPROVE')) return 'approve'
  if (upper.includes('VOTE: REJECT')) return 'reject'
  return 'abstain'
}

function tallyVotes(votes: readonly CommitteeVote[]): 'approved' | 'rejected' | 'no_quorum' {
  const cast = votes.filter(v => v.vote !== 'abstain')
  if (cast.length === 0) return 'no_quorum'

  const approvals = cast.filter(v => v.vote === 'approve').length
  const majority = Math.ceil(cast.length / 2)
  return approvals >= majority ? 'approved' : 'rejected'
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

async function runCommitteeAgent(
  issue: Issue,
  agent: AgentDefinition,
  deps: CommitteePipelineDeps,
): Promise<CommitteeVote> {
  const { company, taskAdapter, costTracker, getAdapter } = deps

  console.log(`[committee] ${agent.id}: reviewing "${issue.title}"`)

  const systemPrompt = await buildSystemPrompt(agent, company)

  const messages: LLMMessage[] = [{
    role: 'user',
    content: [
      `## Proposal for Review\n\n**${issue.title}**`,
      issue.body ? `\n${issue.body}` : '',
      '\n---',
      '\nPlease review this proposal against the current codebase.',
      'Provide your technical analysis and explicitly state **VOTE: APPROVE** or **VOTE: REJECT**.',
    ].join('\n'),
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
    }
  }
}

// ── External agent dispatch via gateway ─────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 15_000
const DEFAULT_EXTERNAL_TIMEOUT_MS = 5 * 60_000

async function dispatchExternalAgent(
  issue: Issue,
  agent: AgentDefinition,
  deps: CommitteePipelineDeps,
  systemPrompt: string,
): Promise<CommitteeVote> {
  const { gateway } = deps
  const config = deps.externalAgents ?? {}
  const timeout = config.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS

  // Gateway path: dispatch via WebSocket
  if (gateway) {
    const taskId = `${issue.id}:${agent.id}`
    console.log(`[committee] ${agent.id}: dispatching via gateway (timeout ${timeout / 1000}s)`)

    gateway.assign(agent.id, {
      id: taskId,
      issueId: issue.id,
      title: issue.title,
      body: issue.body,
      systemPrompt,
      createdAt: new Date().toISOString(),
    })

    try {
      const result = await gateway.waitForResult(taskId, timeout)
      const vote = extractVote(result.content)
      console.log(`[committee] ${agent.id}: gateway vote received — ${vote}`)

      return {
        agentId: agent.id,
        agentName: agent.name,
        vote,
        summary: result.content.slice(0, 500),
        response: result.content,
        costUsd: 0,
      }
    } catch {
      console.log(`[committee] ${agent.id}: gateway vote timed out`)
      return { agentId: agent.id, agentName: agent.name, vote: 'abstain', summary: 'External agent timed out', response: '', costUsd: 0 }
    }
  }

  // Fallback: poll Linear comments
  return pollForExternalVote(issue, agent, deps)
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
    return { agentId: agent.id, agentName: agent.name, vote: 'abstain', summary: 'No gateway or getComments available', response: '', costUsd: 0 }
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
        }
      }
    }

    await new Promise(r => setTimeout(r, pollInterval))
  }

  console.log(`[committee] ${agent.id}: external vote timed out`)
  return { agentId: agent.id, agentName: agent.name, vote: 'abstain', summary: 'External agent timed out', response: '', costUsd: 0 }
}

// ── Main committee pipeline ──────────────────────────────────────

export async function executeCommitteeReview(
  issue: Issue,
  agents: readonly AgentDefinition[],
  deps: CommitteePipelineDeps,
): Promise<CommitteeResult> {
  const { taskAdapter, costTracker, company } = deps
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
  const votes = await Promise.all([
    ...internalAgents.map(agent => runCommitteeAgent(issue, agent, deps)),
    ...externalAgents.map(async agent =>
      dispatchExternalAgent(issue, agent, deps, await buildSystemPrompt(agent, company))),
  ])

  const outcome = tallyVotes(votes)
  const totalCost = votes.reduce((sum, v) => sum + v.costUsd, 0)
  const duration = Math.round(performance.now() - startTime)

  // Post individual responses
  for (const vote of votes) {
    if (vote.response) {
      await taskAdapter.addComment(issue.id, vote.response)
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
    `> Total cost: $${totalCost.toFixed(4)}`,
  ].join('\n')

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
