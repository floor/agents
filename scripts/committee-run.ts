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
import type { TaskAdapter, Issue, ContextBuilder, StateStore } from '@floor-agents/core'
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
import { committeeConfigPath, selectVoters } from './lib/committee-env.ts'
import { startBridges } from './lib/bridges.ts'
import { reviewerSandbox } from '@floor-agents/sandbox'

const expand = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

const REPO = expand(process.env.CODEX_CWD ?? join(homedir(), 'Code/floor/vlist'))
const PORT = parseInt(process.env.GATEWAY_PORT ?? '3199', 10)
const CONFIG = committeeConfigPath(REPO)
const RFC_FILE = expand(process.env.RFC_FILE ?? '')
// Comma-separated agent ids to include. Default trio: claude (internal) + codex +
// grok (both external CLI bridges). Antigravity is parked (GUI has no unattended wake).
const ONLY = (process.env.AGENTS ?? 'claude,codex,grok').split(',').map(s => s.trim())

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
  const agents = selectVoters(company.agents, ONLY, CONFIG)
  console.log(`[run] RFC: ${title}`)
  console.log(`[run] repo: ${REPO}`)
  console.log(`[run] agents: ${agents.map(a => `${a.id}${a.external ? ' (external)' : ''}`).join(', ')}\n`)

  const gateway = createGateway({ port: PORT })
  gateway.start()

  // One bridge per external member, chosen by its `provider` in the manifest.
  const bridges = await startBridges(agents, { port: PORT, repo: REPO, gateway, log: m => console.log(`[run] ${m}`) })

  // Claude reviews in-process with Bash, so it runs in a reviewer sandbox: it
  // reads the repository and cannot write anything outside its own state.
  const claudeCode = createClaudeCodeAdapter({
    cwd: REPO,
    model: 'opus',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    sandbox: reviewerSandbox('claude'),
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

  bridges.stop()
  gateway.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[run] error:', err)
  process.exit(1)
})
