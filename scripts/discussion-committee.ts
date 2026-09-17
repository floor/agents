#!/usr/bin/env bun
/**
 * Deliberative committee on a GitHub Discussion.
 *
 * The Discussion (an "Ideas" RFC) is both the source and the venue: each agent
 * reads the RFC from the discussion body + the thread so far, posts its own
 * review as a comment, and the committee deliberates over multiple rounds until
 * the votes converge (unanimous or stable) or a round cap is hit. A final
 * consensus comment records the outcome. No human in the loop.
 *
 * Round 1  — each agent reviews the RFC independently and votes.
 * Round 2+ — each agent reads the others' latest comments and may revise.
 * Stop     — unanimous, or no vote changed this round, or MAX_ROUNDS reached.
 *
 *   DISCUSSION=117 CODEX_CWD=~/Code/floor/vlist AGENTS=claude,codex,grok \
 *   DRY_RUN=1 bun scripts/discussion-committee.ts
 *
 * DRY_RUN=1 prints every comment to stdout instead of posting to GitHub — use it
 * to validate a run before writing to the public thread.
 */

import { loadCompanyConfig } from '@floor-agents/core'
import type { AgentDefinition, CompanyConfig, LLMMessage } from '@floor-agents/core'
import { createClaudeCodeAdapter } from '@floor-agents/claude-code'
import { createGateway, type Gateway } from '@floor-agents/gateway'
import { createDiscussionsAdapter, type DiscussionsAdapter } from '@floor-agents/github'
import {
  buildSystemPrompt, runToolUseLoop, createCostTracker,
  runDeliberation, createTelegramChannel, type Turn, type TeamChannel, type TeamMessage,
} from '@floor-agents/orchestrator'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { committeeConfigPath, parseMaxRounds, telegramSettings } from './lib/committee-env.ts'

const expand = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

const REPO = expand(process.env.CODEX_CWD ?? join(homedir(), 'Code/floor/vlist'))
const PORT = parseInt(process.env.GATEWAY_PORT ?? '3199', 10)
const CONFIG = committeeConfigPath(REPO)
const OWNER = process.env.REPO_OWNER ?? 'floor'
const REPO_NAME = process.env.REPO_NAME ?? 'vlist'
const DISCUSSION = parseInt(process.env.DISCUSSION ?? '', 10)
const ONLY = (process.env.AGENTS ?? 'claude,codex,grok').split(',').map(s => s.trim())
const MAX_ROUNDS = parseMaxRounds(process.env.MAX_ROUNDS)
const TIMEOUT_MS = parseInt(process.env.EXTERNAL_TIMEOUT_MS ?? '900000', 10)
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'

type Vote = 'approve' | 'reject' | 'abstain'

function extractVote(text: string): Vote {
  const upper = text.toUpperCase()
  if (upper.includes('VOTE: APPROVE')) return 'approve'
  if (upper.includes('VOTE: REJECT')) return 'reject'
  return 'abstain'
}

// Strip ANSI escape codes — CLI stderr is colorized and must never reach a comment.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*[A-Za-z]/g, '')
}

function badge(vote: Vote): string {
  return vote === 'approve' ? '✅ APPROVE' : vote === 'reject' ? '❌ REJECT' : '⚪ ABSTAIN'
}

function tally(votes: readonly Vote[]): 'approved' | 'rejected' | 'no_quorum' {
  const cast = votes.filter(v => v !== 'abstain')
  if (cast.length === 0) return 'no_quorum'
  const approvals = cast.filter(v => v === 'approve').length
  return approvals > cast.length / 2 ? 'approved' : 'rejected'
}

if (!DISCUSSION) {
  console.error('DISCUSSION (discussion number) is required')
  process.exit(1)
}

async function githubToken(): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const proc = Bun.spawn(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'pipe' })
  const token = (await new Response(proc.stdout).text()).trim()
  if ((await proc.exited) !== 0 || !token) {
    throw new Error('no GITHUB_TOKEN and `gh auth token` failed')
  }
  return token
}

/** The user-facing review prompt body: the RFC + (round 2+) the peers' last comments + any human guidance. */
function proposalBody(
  rfc: string,
  round: number,
  peers: ReadonlyArray<{ name: string; text: string }>,
  humanMessages: ReadonlyArray<TeamMessage>,
): string {
  const human = humanMessages.length > 0
    ? ['', '---', '## Human guidance (from the team channel — weigh this heavily)', '',
       ...humanMessages.map(m => `- ${m.text}`)]
    : []
  if (round === 1 || peers.length === 0) {
    return human.length > 0 ? [rfc, ...human].join('\n') : rfc
  }
  return [
    rfc,
    '',
    '---',
    `## Other reviewers — Round ${round - 1}`,
    '',
    ...peers.map(p => `### ${p.name}\n\n${p.text}`),
    ...human,
    '',
    '---',
    `This is round ${round} of the committee's deliberation. You have now seen the other`,
    'reviewers above. Reconsider your position in light of their arguments: revise your vote',
    'if they changed your mind, or hold it and say concisely why their objection does not move',
    'you. End with exactly **VOTE: APPROVE** or **VOTE: REJECT**.',
  ].join('\n')
}

function claudeUserContent(title: string, body: string): string {
  return [
    `## Proposal: ${title}`,
    '',
    body,
    '',
    '---',
    `Review this proposal against the codebase at ${REPO}.`,
    'Provide your technical analysis, then end with exactly **VOTE: APPROVE** or **VOTE: REJECT**.',
  ].join('\n')
}

type Review = { agent: AgentDefinition; vote: Vote; text: string; costUsd: number }

async function reviewOnce(
  agent: AgentDefinition,
  round: number,
  title: string,
  body: string,
  company: CompanyConfig,
  gateway: Gateway,
  getAdapter: (provider: string) => ReturnType<typeof createClaudeCodeAdapter>,
): Promise<Review> {
  const systemPrompt = await buildSystemPrompt(agent, company)
  try {
    if (agent.external) {
      const taskId = `disc-${DISCUSSION}-r${round}-${agent.id}`
      const resultP = gateway.waitForResult(taskId, TIMEOUT_MS)
      gateway.assign(agent.id, {
        id: taskId,
        issueId: `disc-${DISCUSSION}`,
        title,
        body,
        systemPrompt,
        createdAt: new Date().toISOString(),
      })
      const result = await resultP
      return { agent, vote: extractVote(result.content), text: result.content, costUsd: 0 }
    }
    const messages: LLMMessage[] = [{ role: 'user', content: claudeUserContent(title, body) }]
    const result = await runToolUseLoop(agent, systemPrompt, messages, [], getAdapter)
    return { agent, vote: extractVote(result.content), text: result.content, costUsd: result.totalCost }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const clean = stripAnsi(raw).replace(/\s+/g, ' ').trim()
    console.error(`[deliberation] ${agent.id} round ${round}: ${clean}`)
    // Never dump raw CLI stderr into the public thread — post a short, dignified note.
    return {
      agent,
      vote: 'abstain',
      text: `_${agent.name} could not complete a review this round (tool error) and is abstaining._`,
      costUsd: 0,
    }
  }
}

async function main() {
  const company = await loadCompanyConfig(CONFIG)
  const agents = company.agents.filter(
    (a: AgentDefinition) => a.capabilities.includes('vote') && ONLY.includes(a.id),
  )

  const discussions: DiscussionsAdapter = createDiscussionsAdapter({
    token: await githubToken(),
    owner: OWNER,
    repo: REPO_NAME,
  })

  const discussion = await discussions.getDiscussion(DISCUSSION)
  if (!discussion) {
    console.error(`discussion #${DISCUSSION} not found in ${OWNER}/${REPO_NAME}`)
    process.exit(1)
  }

  console.log(`[deliberation] discussion #${DISCUSSION}: "${discussion.title}"`)
  console.log(`[deliberation] agents: ${agents.map(a => a.id).join(', ')}  rounds≤${MAX_ROUNDS}  ${DRY_RUN ? 'DRY RUN' : 'LIVE — will post to GitHub'}`)

  const post = async (markdown: string): Promise<void> => {
    if (DRY_RUN) {
      console.log('\n┌──────── COMMENT (dry run) ────────')
      console.log(markdown.split('\n').map(l => '│ ' + l).join('\n'))
      console.log('└───────────────────────────────────\n')
      return
    }
    await discussions.postComment(discussion.id, markdown)
  }

  const gateway = createGateway({ port: PORT })
  gateway.start()

  const bridges: { kill(): void }[] = []
  for (const id of ['codex', 'grok'] as const) {
    if (!agents.some(a => a.id === id && a.external)) continue
    const env = { ...process.env, GATEWAY_URL: `ws://localhost:${PORT}`, CODEX_CWD: REPO, GROK_CWD: REPO }
    bridges.push(Bun.spawn(['bun', join(import.meta.dir, `${id}-agent.ts`)], { env, stdout: 'inherit', stderr: 'inherit' }))
    for (let i = 0; i < 30 && !gateway.isAgentConnected(id); i++) await new Promise(r => setTimeout(r, 500))
    console.log(`[deliberation] ${id} connected: ${gateway.isAgentConnected(id)}`)
  }

  const claudeCode = createClaudeCodeAdapter({ cwd: REPO, model: 'opus', allowedTools: ['Read', 'Glob', 'Grep', 'Bash'] })
  const getAdapter = (provider: string) => {
    if (provider === 'claude-code') return claudeCode
    throw new Error(`only claude-code is wired internally, got: ${provider}`)
  }

  const costTracker = createCostTracker()
  await post([
    `## 🏛️ Committee deliberation — ${discussion.title}`,
    '',
    `Reviewers: ${agents.map(a => `**${a.name}**`).join(', ')}. Up to ${MAX_ROUNDS} rounds; consensus = unanimous or stable.`,
    '',
    'Each reviewer posts below. Round 2+ reviewers respond to each other and may revise their vote.',
  ].join('\n'))

  // Shared channel: when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set, turns stream
  // to Telegram and the human can interject between rounds (folded into the prompt).
  // In a GROUP chat, set TELEGRAM_ALLOW_FROM to the operator user ids — every member's
  // messages carry the same chat id, so without it the channel hears no one.
  // DRY_RUN keeps Telegram off too: a message there is publication.
  const telegram = telegramSettings(process.env, DRY_RUN)
  const channel: TeamChannel | undefined = telegram
    ? createTelegramChannel({ ...telegram, log: msg => console.log(`[telegram] ${msg}`) })
    : undefined
  if (channel) console.log('[deliberation] team channel: Telegram (live stream + human interjection)')
  else if (DRY_RUN && process.env.TELEGRAM_BOT_TOKEN) console.log('[deliberation] DRY RUN: Telegram not used')
  const byId = new Map(agents.map(a => [a.id, a]))

  const { turns, stopReason, votesByAgent } = await runDeliberation<Vote>({
    agents: agents.map(a => ({ id: a.id, name: a.name })),
    maxRounds: MAX_ROUNDS,
    channel,
    review: async (a, ctx) => {
      const def = byId.get(a.id)!
      const body = proposalBody(discussion.body, ctx.round, ctx.peers, ctx.humanMessages)
      const r = await reviewOnce(def, ctx.round, discussion.title, body, company, gateway, getAdapter)
      costTracker.recordCost(`disc-${DISCUSSION}`, r.costUsd)
      console.log(`[deliberation] ${a.id} r${ctx.round}: ${r.vote}${r.costUsd ? ` ($${r.costUsd.toFixed(4)})` : ''}`)
      return { vote: r.vote, text: r.text }
    },
    onTurn: async (t: Turn<Vote>) => {
      await post(`### ${badge(t.vote)} · ${t.agent.name} — Round ${t.round}\n\n${stripAnsi(t.text)}`)
    },
    summarize: (t: Turn<Vote>) => `${badge(t.vote)} · Round ${t.round}\n${stripAnsi(t.text).slice(0, 600)}`,
    converged: (votes, previous, round) => {
      // Budget gate first: a run that has spent its allowance stops here whatever the
      // votes say. A round boundary is the only safe place to cut a deliberation, and
      // without this the only real limit is MAX_ROUNDS × agents full model sessions.
      const spent = costTracker.getTaskCost(`disc-${DISCUSSION}`)
      if (spent > company.costs.maxCostPerTask) {
        return {
          stop: true,
          reason: `budget exhausted after round ${round} ($${spent.toFixed(2)} of $${company.costs.maxCostPerTask.toFixed(2)})`,
        }
      }
      const list = agents.map(a => votes[a.id]!)
      const cast = list.filter(v => v !== 'abstain')
      if (cast.length === agents.length && cast.every(v => v === cast[0])) {
        return { stop: true, reason: `unanimous after round ${round}` }
      }
      if (previous && agents.every(a => votes[a.id] === previous[a.id])) {
        return { stop: true, reason: `votes stable after round ${round} (no one revised)` }
      }
      return null
    },
  })

  const finalReviews = turns.map(t => ({ agent: byId.get(t.agent.id)!, vote: t.vote, text: t.text }))
  void votesByAgent
  const outcome = tally(finalReviews.map(r => r.vote))
  await post([
    `## 🗳️ Committee consensus — ${outcome.toUpperCase()}`,
    '',
    '| Reviewer | Final vote |',
    '|----------|------------|',
    ...finalReviews.map(r => `| ${r.agent.name} | **${badge(r.vote)}** |`),
    '',
    `**Outcome: ${outcome.toUpperCase()}** — ${stopReason}.`,
    '',
    '_Posted autonomously by the Floor Agents committee._',
  ].join('\n'))

  console.log(`\n════════ CONSENSUS ════════`)
  console.log(`outcome: ${outcome}  (${stopReason})`)
  for (const r of finalReviews) console.log(`  ${r.agent.name.padEnd(8)} → ${r.vote}`)
  // Cost stays in the operator console, never in the public thread.
  console.log(`cost (Claude API only; CLIs unmetered): $${costTracker.getTaskCost(`disc-${DISCUSSION}`).toFixed(4)}`)

  for (const b of bridges) b.kill()
  gateway.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[deliberation] error:', err)
  process.exit(1)
})
