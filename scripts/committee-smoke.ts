#!/usr/bin/env bun
/**
 * Committee smoke test — proves a live 2-way round (Claude internal + Codex via
 * the gateway) on a real vlist RFC, without Things/GitHub/main.ts.
 *
 * It stands up a real gateway, spawns the local Codex bridge, builds an in-memory
 * issue, runs executeCommitteeReview, prints the votes, then tears everything down.
 *
 *   CODEX_CWD=~/Code/floor/vlist bun scripts/committee-smoke.ts
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
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = process.env.CODEX_CWD ?? join(homedir(), 'Code/floor/vlist')
const PORT = parseInt(process.env.GATEWAY_PORT ?? '3199', 10)
const CONFIG = join(homedir(), 'Code/floor/.agents/projects/vlist/agents.yaml')

// ── The RFC under review ────────────────────────────────────────
const issue: Issue = {
  id: 'rfc-smoke-001',
  title: 'RFC: replace the prefix-sum size cache with a Fenwick (binary indexed) tree',
  body: [
    'Proposal: replace the current prefix-sum array in `src/core/sizes.ts` with a',
    'Fenwick tree so that a single item resize is O(log n) to apply instead of O(n)',
    'to rebuild the suffix of the prefix-sum array.',
    '',
    'Motivation: with autosize, frequent single-item size changes each trigger a',
    'prefix-sum recomputation from the changed index onward. A Fenwick tree makes',
    'point-update + prefix-query both O(log n).',
    '',
    'Tradeoff: offset lookups (getOffset) become O(log n) instead of O(1), which is',
    'on the hot scroll path. The claim is that the per-frame cost is still negligible',
    'for typical viewport sizes.',
  ].join('\n'),
  status: 'in_progress',
  labels: ['committee'],
  createdAt: new Date(),
  updatedAt: new Date(),
}

// ── Minimal task adapter — just logs what the committee posts ────
const taskAdapter = {
  async getIssue() { return issue },
  async addComment(_id: string, text: string) {
    console.log('\n──────── committee post ────────\n' + text + '\n')
  },
  async setStatus(_id: string, status: string) { console.log(`[task] status → ${status}`) },
  async setLabel(_id: string, label: string) { console.log(`[task] label → ${label}`) },
} as unknown as TaskAdapter

async function main() {
  const company = await loadCompanyConfig(CONFIG)
  // 2-way for the smoke test: skip antigravity (no bridge yet → would just time out).
  const agents = company.agents.filter(a => a.id === 'claude' || a.id === 'codex')
  console.log(`[smoke] agents: ${agents.map(a => `${a.id}${a.external ? ' (external)' : ''}`).join(', ')}`)

  const gateway = createGateway({ port: PORT })
  gateway.start()
  console.log(`[smoke] gateway up on :${PORT}`)

  // Spawn the local Codex bridge pointed at our gateway.
  const bridge = Bun.spawn(['bun', join(import.meta.dir, 'codex-agent.ts')], {
    env: { ...process.env, GATEWAY_URL: `ws://localhost:${PORT}`, CODEX_CWD: REPO },
    stdout: 'inherit',
    stderr: 'inherit',
  })

  // Wait for Codex to register (up to ~15s).
  for (let i = 0; i < 30 && !gateway.isAgentConnected('codex'); i++) {
    await new Promise(r => setTimeout(r, 500))
  }
  console.log(`[smoke] codex connected: ${gateway.isAgentConnected('codex')}`)

  const claudeCode = createClaudeCodeAdapter({
    cwd: REPO,
    model: 'opus',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
  })

  const deps: CommitteePipelineDeps = {
    company,
    taskAdapter,
    contextBuilder: undefined as unknown as ContextBuilder, // unused by executeCommitteeReview
    stateStore: undefined as unknown as StateStore,         // unused by executeCommitteeReview
    costTracker: createCostTracker(),
    getAdapter: (provider) => {
      if (provider === 'claude-code') return claudeCode
      throw new Error(`smoke harness only wires claude-code, got: ${provider}`)
    },
    externalAgents: { timeoutMs: 300_000 },
    gateway,
  }

  console.log('[smoke] running committee review…\n')
  const result = await executeCommitteeReview(issue, agents, deps)

  console.log('\n════════ RESULT ════════')
  console.log('outcome:', result.outcome)
  for (const v of result.votes) {
    console.log(`  ${v.agentName.padEnd(12)} → ${v.vote}`)
  }
  console.log('total cost: $' + result.totalCost.toFixed(4))

  bridge.kill()
  gateway.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[smoke] error:', err)
  process.exit(1)
})
