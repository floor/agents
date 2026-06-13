#!/usr/bin/env bun
/**
 * Run a committee review on an RFC markdown file.
 *
 * Stands up a real gateway, spawns the local Codex bridge, reads the RFC from
 * disk, runs executeCommitteeReview with whichever committee agents are wired,
 * prints the votes, then tears down. Reviews are grounded in CODEX_CWD (the repo
 * the RFC is about), not the docs repo.
 *
 *   RFC_FILE=~/Code/floor/vlist.io/docs/refactor/RFC-013-integrated-draft.md \
 *   CODEX_CWD=~/Code/floor/vlist \
 *   bun scripts/committee-run.ts
 */

import { loadCompanyConfig } from '@floor-agents/core'
import type { TaskAdapter, Issue, ContextBuilder, StateStore, AgentDefinition } from '@floor-agents/core'
import { createClaudeCodeAdapter } from '@floor-agents/claude-code'
import { createGateway } from '@floor-agents/gateway'
import {
  executeCommitteeReview,
  createCostTracker,
  type CommitteePipelineDeps,
} from '@floor-agents/orchestrator'
import { parseRfc } from './lib/rfc.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

const expand = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

const REPO = expand(process.env.CODEX_CWD ?? join(homedir(), 'Code/floor/vlist'))
const PORT = parseInt(process.env.GATEWAY_PORT ?? '3199', 10)
const CONFIG = join(homedir(), 'Code/floor/.agents/projects/vlist/agents.yaml')
const RFC_FILE = expand(process.env.RFC_FILE ?? '')
// Comma-separated agent ids to include (default: claude + codex; add antigravity
// once its bridge is running).
const ONLY = (process.env.AGENTS ?? 'claude,codex').split(',').map(s => s.trim())

if (!RFC_FILE) {
  console.error('RFC_FILE is required')
  process.exit(1)
}

async function main() {
  const { id, title, body } = parseRfc(await Bun.file(RFC_FILE).text(), RFC_FILE)

  const issue: Issue = {
    id,
    title,
    body,
    status: 'in_progress',
    labels: ['committee'],
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const taskAdapter = {
    async getIssue() { return issue },
    async addComment(_id: string, text: string) {
      console.log('\n──────── committee post ────────\n' + text + '\n')
    },
    async setStatus(_id: string, status: string) { console.log(`[task] status → ${status}`) },
    async setLabel(_id: string, label: string) { console.log(`[task] label → ${label}`) },
  } as unknown as TaskAdapter

  const company = await loadCompanyConfig(CONFIG)
  const agents = company.agents.filter(
    (a: AgentDefinition) => a.capabilities.includes('vote') && ONLY.includes(a.id),
  )
  console.log(`[run] RFC: ${title}`)
  console.log(`[run] repo: ${REPO}`)
  console.log(`[run] agents: ${agents.map(a => `${a.id}${a.external ? ' (external)' : ''}`).join(', ')}\n`)

  const gateway = createGateway({ port: PORT })
  gateway.start()

  const needCodex = agents.some(a => a.id === 'codex')
  const bridge = needCodex
    ? Bun.spawn(['bun', join(import.meta.dir, 'codex-agent.ts')], {
        env: { ...process.env, GATEWAY_URL: `ws://localhost:${PORT}`, CODEX_CWD: REPO },
        stdout: 'inherit',
        stderr: 'inherit',
      })
    : null

  // Antigravity's persistent relay (the gateway side). Antigravity itself only
  // runs the stateless antigravity-notify.ts background task + reviews via MCP.
  const needAntigravity = agents.some(a => a.id === 'antigravity')
  const relay = needAntigravity
    ? Bun.spawn(['bun', join(import.meta.dir, 'antigravity-relay.ts')], {
        env: { ...process.env, GATEWAY_URL: `ws://localhost:${PORT}` },
        stdout: 'inherit',
        stderr: 'inherit',
      })
    : null

  if (needCodex) {
    for (let i = 0; i < 30 && !gateway.isAgentConnected('codex'); i++) {
      await new Promise(r => setTimeout(r, 500))
    }
    console.log(`[run] codex connected: ${gateway.isAgentConnected('codex')}`)
  }

  const claudeCode = createClaudeCodeAdapter({
    cwd: REPO,
    model: 'opus',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
  })

  const deps: CommitteePipelineDeps = {
    company,
    taskAdapter,
    contextBuilder: undefined as unknown as ContextBuilder,
    stateStore: undefined as unknown as StateStore,
    costTracker: createCostTracker(),
    getAdapter: (provider) => {
      if (provider === 'claude-code') return claudeCode
      throw new Error(`run harness only wires claude-code, got: ${provider}`)
    },
    externalAgents: { timeoutMs: parseInt(process.env.EXTERNAL_TIMEOUT_MS ?? '600000', 10) },
    gateway,
  }

  console.log('[run] running committee review…\n')
  const result = await executeCommitteeReview(issue, agents, deps)

  console.log('\n════════ RESULT ════════')
  console.log('outcome:', result.outcome)
  for (const v of result.votes) console.log(`  ${v.agentName.padEnd(12)} → ${v.vote}`)
  console.log('total cost: $' + result.totalCost.toFixed(4))

  bridge?.kill()
  relay?.kill()
  gateway.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[run] error:', err)
  process.exit(1)
})
