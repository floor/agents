#!/usr/bin/env bun
/**
 * Decision committee — deliberates a binary architectural choice and recommends.
 *
 * Unlike discussion-committee.ts (which reviews an RFC and votes APPROVE/REJECT),
 * this poses a single decision (default: RFC-013 Option A vs B) from a brief, runs
 * the same multi-round deliberation, and tallies RECOMMEND: A / RECOMMEND: B.
 * Console-only — it does not post to GitHub.
 *
 *   BRIEF_FILE=scripts/lib/decision-brief.md CODEX_CWD=~/Code/floor/vlist \
 *   AGENTS=claude,codex,grok MAX_ROUNDS=3 bun scripts/decision-committee.ts
 */

import { loadCompanyConfig } from '@floor-agents/core'
import type { AgentDefinition, CompanyConfig, LLMMessage } from '@floor-agents/core'
import { createClaudeCodeAdapter } from '@floor-agents/claude-code'
import { createGateway, type Gateway } from '@floor-agents/gateway'
import {
  buildSystemPrompt, runToolUseLoop, createCostTracker,
  runDeliberation, createTelegramChannel, type Turn, type TeamChannel, type TeamMessage,
} from '@floor-agents/orchestrator'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { committeeConfigPath, parseMaxRounds, selectVoters } from './lib/committee-env.ts'

const expand = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)
const REPO = expand(process.env.CODEX_CWD ?? join(homedir(), 'Code/floor/vlist'))
const PORT = parseInt(process.env.GATEWAY_PORT ?? '3199', 10)
const CONFIG = committeeConfigPath(REPO)
const BRIEF_FILE = expand(process.env.BRIEF_FILE ?? join(import.meta.dir, 'lib/decision-brief.md'))
const ONLY = (process.env.AGENTS ?? 'claude,codex,grok').split(',').map(s => s.trim())
const MAX_ROUNDS = parseMaxRounds(process.env.MAX_ROUNDS)
const TIMEOUT_MS = parseInt(process.env.EXTERNAL_TIMEOUT_MS ?? '900000', 10)
const TITLE = process.env.DECISION_TITLE ?? 'RFC-013 v3 touch engine — Option A or B'
// Full per-round deliberation transcript (every agent, every round) → a durable,
// browsable markdown file. Without this the rounds are lost (console only).
const TRANSCRIPT_FILE = expand(process.env.TRANSCRIPT_FILE ?? join(homedir(), '.floor-committee', 'last-decision-transcript.md'))

type Pick = 'A' | 'B' | 'unclear'

function extractPick(text: string): Pick {
  const u = text.toUpperCase()
  // Tier 1: the literal token. Tier 2: prose ("choose/approve/recommend Option A",
  // "Option A for v3") — agents often answer in prose despite the instruction, so
  // falling back to the last clear A/B mention avoids false "unclear" tallies.
  const last = (...needles: string[]): number =>
    needles.reduce((m, n) => Math.max(m, u.lastIndexOf(n)), -1)
  const a = last('RECOMMEND: A', 'RECOMMEND A', 'RECOMMEND OPTION A', 'CHOOSE OPTION A',
    'APPROVE OPTION A', 'OPTION A FOR V3', 'OPTION A FOR 3.0', 'PICK OPTION A')
  const b = last('RECOMMEND: B', 'RECOMMEND B', 'RECOMMEND OPTION B', 'CHOOSE OPTION B',
    'APPROVE OPTION B', 'OPTION B FOR V3', 'OPTION B FOR 3.0', 'PICK OPTION B')
  if (a === -1 && b === -1) return 'unclear'
  return a > b ? 'A' : 'B'
}

function buildBody(
  brief: string,
  round: number,
  peers: ReadonlyArray<{ name: string; text: string }>,
  humanMessages: ReadonlyArray<TeamMessage>,
): string {
  const human = humanMessages.length > 0
    ? ['', '---', '## Human guidance (from the team channel — weigh this heavily)', '',
       ...humanMessages.map(m => `- ${m.text}`)]
    : []
  if (round === 1 || peers.length === 0) {
    return human.length > 0 ? [brief, ...human].join('\n') : brief
  }
  return [
    brief,
    '', '---',
    `## Other reviewers — Round ${round - 1}`, '',
    ...peers.map(p => `### ${p.name}\n\n${p.text}`),
    ...human,
    '', '---',
    `This is round ${round}. Respond to the other reviewers above; hold or change your`,
    'recommendation and say why. End with **RECOMMEND: A** or **RECOMMEND: B**.',
  ].join('\n')
}

function claudeContent(body: string): string {
  return [
    `## Decision: ${TITLE}`, '', body, '', '---',
    `You may read the codebase at ${REPO} to verify any claim.`,
    'End with exactly **RECOMMEND: A** or **RECOMMEND: B**.',
  ].join('\n')
}

type Rec = { agent: AgentDefinition; pick: Pick; text: string; costUsd: number }

async function decideOnce(
  agent: AgentDefinition, round: number, body: string,
  company: CompanyConfig, gateway: Gateway,
  getAdapter: (p: string) => ReturnType<typeof createClaudeCodeAdapter>,
): Promise<Rec> {
  const systemPrompt = await buildSystemPrompt(agent, company)
  try {
    if (agent.external) {
      const taskId = `decision-r${round}-${agent.id}`
      const resultP = gateway.waitForResult(taskId, TIMEOUT_MS)
      gateway.assign(agent.id, {
        id: taskId, issueId: 'decision', title: TITLE, body, systemPrompt,
        createdAt: new Date().toISOString(),
      })
      const r = await resultP
      return { agent, pick: extractPick(r.content), text: r.content, costUsd: 0 }
    }
    const messages: LLMMessage[] = [{ role: 'user', content: claudeContent(body) }]
    const r = await runToolUseLoop(agent, systemPrompt, messages, [], getAdapter)
    return { agent, pick: extractPick(r.content), text: r.content, costUsd: r.totalCost }
  } catch (err) {
    console.error(`[decision] ${agent.id} r${round}: ${err instanceof Error ? err.message : String(err)}`)
    return { agent, pick: 'unclear', text: '', costUsd: 0 }
  }
}

async function main() {
  const company = await loadCompanyConfig(CONFIG)
  const agents = selectVoters(company.agents, ONLY, CONFIG)
  const brief = await Bun.file(BRIEF_FILE).text()

  console.log(`[decision] "${TITLE}"`)
  console.log(`[decision] agents: ${agents.map(a => a.id).join(', ')}  rounds≤${MAX_ROUNDS}\n`)

  const gateway = createGateway({ port: PORT })
  gateway.start()
  const bridges: { kill(): void }[] = []
  for (const id of ['codex', 'grok'] as const) {
    if (!agents.some(a => a.id === id && a.external)) continue
    bridges.push(Bun.spawn(['bun', join(import.meta.dir, `${id}-agent.ts`)], {
      env: { ...process.env, GATEWAY_URL: `ws://localhost:${PORT}`, CODEX_CWD: REPO, GROK_CWD: REPO },
      stdout: 'inherit', stderr: 'inherit',
    }))
    for (let i = 0; i < 30 && !gateway.isAgentConnected(id); i++) await new Promise(r => setTimeout(r, 500))
    console.log(`[decision] ${id} connected: ${gateway.isAgentConnected(id)}`)
  }

  const claudeCode = createClaudeCodeAdapter({ cwd: REPO, model: 'opus', allowedTools: ['Read', 'Glob', 'Grep', 'Bash'] })
  const getAdapter = (p: string) => {
    if (p === 'claude-code') return claudeCode
    throw new Error(`only claude-code wired internally, got: ${p}`)
  }
  const costTracker = createCostTracker()

  // Shared channel: when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set, turns stream
  // to Telegram and the human can interject between rounds.
  // In a GROUP chat, set TELEGRAM_ALLOW_FROM to the operator user ids — every member's
  // messages carry the same chat id, so without it the channel hears no one.
  const channel: TeamChannel | undefined =
    process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
      ? createTelegramChannel({
          token: process.env.TELEGRAM_BOT_TOKEN,
          chatId: process.env.TELEGRAM_CHAT_ID,
          allowFrom: process.env.TELEGRAM_ALLOW_FROM?.split(',').map(s => s.trim()).filter(Boolean),
          log: msg => console.log(`[telegram] ${msg}`),
        })
      : undefined
  if (channel) console.log('[decision] team channel: Telegram (live stream + human interjection)')
  const byId = new Map(agents.map(ag => [ag.id, ag]))
  const transcript: string[] = []   // full text of every agent, every round

  const { turns, stopReason: stop } = await runDeliberation<Pick>({
    agents: agents.map(ag => ({ id: ag.id, name: ag.name })),
    maxRounds: MAX_ROUNDS,
    channel,
    review: async (ag, ctx) => {
      const def = byId.get(ag.id)!
      const r = await decideOnce(def, ctx.round, buildBody(brief, ctx.round, ctx.peers, ctx.humanMessages), company, gateway, getAdapter)
      costTracker.recordCost('decision', r.costUsd)
      console.log(`[decision] ${ag.id} r${ctx.round}: ${r.pick}${r.costUsd ? ` ($${r.costUsd.toFixed(4)})` : ''}`)
      return { vote: r.pick, text: r.text }
    },
    onTurn: async (t: Turn<Pick>) => {
      transcript.push(`## Round ${t.round} — ${t.agent.name} → ${t.vote}\n\n${t.text || '_(no output)_'}`)
    },
    summarize: (t: Turn<Pick>) => `Round ${t.round} → **${t.vote}**\n${t.text.slice(0, 600)}`,
    converged: (votes, previous, round) => {
      // Budget gate first: a run that has spent its allowance stops here whatever the
      // votes say. A round boundary is the only safe place to cut a deliberation, and
      // without this the only real limit is MAX_ROUNDS × agents full model sessions.
      const spent = costTracker.getTaskCost('decision')
      if (spent > company.costs.maxCostPerTask) {
        return {
          stop: true,
          reason: `budget exhausted after round ${round} ($${spent.toFixed(2)} of $${company.costs.maxCostPerTask.toFixed(2)})`,
        }
      }
      const list = agents.map(ag => votes[ag.id]!)
      const decided = list.filter(p => p !== 'unclear')
      if (decided.length === agents.length && decided.every(p => p === decided[0])) {
        return { stop: true, reason: `unanimous after round ${round}` }
      }
      if (previous && agents.every(ag => votes[ag.id] === previous[ag.id])) {
        return { stop: true, reason: `stable after round ${round}` }
      }
      return null
    },
  })

  const recs: Rec[] = turns.map(t => ({ agent: byId.get(t.agent.id)!, pick: t.vote, text: t.text, costUsd: 0 }))
  const a = recs.filter(r => r.pick === 'A').length
  const b = recs.filter(r => r.pick === 'B').length
  const winner = a > b ? 'A' : b > a ? 'B' : 'TIE'

  console.log(`\n════════ DECISION ════════`)
  console.log(`recommendation: OPTION ${winner}  (A:${a}  B:${b}  unclear:${recs.length - a - b}) — ${stop}`)
  for (const r of recs) console.log(`  ${r.agent.name.padEnd(8)} → ${r.pick}`)
  console.log(`cost: $${costTracker.getTaskCost('decision').toFixed(4)}`)

  // Persist the full per-round transcript — durable + browsable (console is ephemeral).
  const doc = [
    `# Decision transcript — ${TITLE}`,
    '',
    `**Recommendation: OPTION ${winner}** (A:${a} B:${b} unclear:${recs.length - a - b}) — ${stop}.`,
    `Agents: ${agents.map(ag => ag.name).join(', ')}. Cost: $${costTracker.getTaskCost('decision').toFixed(4)}.`,
    '',
    '---',
    '',
    ...transcript,
  ].join('\n')
  try {
    await mkdir(dirname(TRANSCRIPT_FILE), { recursive: true })
    await Bun.write(TRANSCRIPT_FILE, doc)
    console.log(`\n[decision] full transcript → ${TRANSCRIPT_FILE}`)
  } catch (err) {
    console.error(`[decision] could not write transcript: ${err instanceof Error ? err.message : String(err)}`)
  }

  for (const br of bridges) br.kill()
  gateway.stop()
  process.exit(0)
}

main().catch((err) => { console.error('[decision] error:', err); process.exit(1) })
