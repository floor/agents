import type {
  CompanyConfig,
  TaskAdapter,
  Issue,
  AgentDefinition,
  StateStore,
  LLMMessage,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import { runToolUseLoop, type LLMAdapterResolver } from './llm-runner.ts'
import type { CostTracker } from './cost-tracker.ts'
import type { DiscussionsAdapter } from '@floor-agents/github'

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

export type CommitteePipelineDeps = {
  readonly company: CompanyConfig
  readonly taskAdapter: TaskAdapter
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly getAdapter: LLMAdapterResolver
  readonly discussions?: DiscussionsAdapter
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

// ── Single agent review ──────────────────────────────────────────

async function runCommitteeAgent(
  issue: Issue,
  agent: AgentDefinition,
  deps: CommitteePipelineDeps,
): Promise<CommitteeVote> {
  const { company, taskAdapter, costTracker, getAdapter } = deps

  console.log(`[committee] ${agent.id}: reviewing "${issue.title}"`)

  const promptPath = agent.promptTemplate
  const promptFile = Bun.file(promptPath)
  const systemPrompt = await promptFile.exists()
    ? await promptFile.text()
    : `You are ${agent.name}, a technical committee member. Review the RFC and vote APPROVE or REJECT.`

  const projectContext = company.project.customInstructions
    ? `\n\n## Project Context\n${company.project.customInstructions}`
    : ''

  const messages: LLMMessage[] = [{
    role: 'user',
    content: [
      `## RFC for Review\n\n**${issue.title}**`,
      issue.body ? `\n${issue.body}` : '',
      '\n---',
      '\nPlease review this RFC against the v1 source code constraints.',
      'Provide your technical analysis and explicitly state **VOTE: APPROVE** or **VOTE: REJECT**.',
    ].join('\n'),
  }]

  try {
    const result = await runToolUseLoop(
      agent,
      systemPrompt + projectContext,
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

// ── Main committee pipeline ──────────────────────────────────────

export async function executeCommitteeReview(
  issue: Issue,
  agents: readonly AgentDefinition[],
  deps: CommitteePipelineDeps,
): Promise<CommitteeResult> {
  const { taskAdapter, costTracker, company } = deps
  const startTime = performance.now()

  console.log(`[committee] starting review: "${issue.title}" with ${agents.length} agents`)

  await taskAdapter.addComment(issue.id, [
    '🏛️ **Committee Review Started**',
    '',
    '| Agent | Provider | Model |',
    '|-------|----------|-------|',
    ...agents.map(a => `| ${a.name} | ${a.llm.provider} | \`${a.llm.model}\` |`),
    '',
    'Agents are reviewing in parallel. Votes will be posted when all reviews complete.',
  ].join('\n'))

  // Run all agents in parallel
  const votes = await Promise.all(
    agents.map(agent => runCommitteeAgent(issue, agent, deps)),
  )

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
