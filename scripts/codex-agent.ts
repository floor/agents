#!/usr/bin/env bun
/**
 * Codex external agent — connects to the Floor Agents gateway via WebSocket,
 * receives RFC review assignments, reviews them with the LOCAL Codex CLI
 * (`codex exec`, read-only sandbox), and sends back its vote.
 *
 * Usage:
 *   GATEWAY_URL=ws://localhost:3100 CODEX_CWD=~/Code/floor/vlist bun scripts/codex-agent.ts
 */

import type { TaskAssignment } from '@floor-agents/gateway'
import { createGatewayClient } from '@floor-agents/gateway'
import { buildCodexPrompt, buildCodexArgs } from './lib/codex.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://localhost:3100'
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN
const CODEX_CWD = process.env.CODEX_CWD ?? process.cwd()
const CODEX_MODEL = process.env.CODEX_MODEL // optional override (e.g. o3, gpt-5-codex)

async function reviewWithCodex(task: TaskAssignment): Promise<string> {
  const prompt = buildCodexPrompt(task)
  const outFile = join(tmpdir(), `codex-review-${crypto.randomUUID()}.txt`)
  const args = buildCodexArgs({
    cwd: CODEX_CWD,
    outFile,
    ...(CODEX_MODEL ? { model: CODEX_MODEL } : {}),
  })

  const proc = Bun.spawn(['codex', ...args], {
    stdin: new TextEncoder().encode(prompt),
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: CODEX_CWD,
  })

  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`codex exec failed (exit ${exitCode}): ${stderr.slice(0, 500)}`)
  }

  const lastMessage = await Bun.file(outFile).text().catch(() => '')
  await rm(outFile, { force: true }).catch(() => {})

  if (lastMessage.trim()) return lastMessage.trim()

  // Fallback: full stdout if the last-message file was empty
  return (await new Response(proc.stdout).text()).trim()
}

const client = createGatewayClient({
  url: GATEWAY_URL,
  agentId: 'codex',
  name: 'Codex (local CLI)',
  capabilities: ['review_rfc', 'vote'],
  token: GATEWAY_TOKEN,
})

client.onTask(async (task) => {
  console.log(`\n[codex] reviewing: "${task.title}" (cwd=${CODEX_CWD})`)
  const result = await reviewWithCodex(task)
  console.log(`[codex] review complete (${result.length} chars)`)
  return result
})

client.connect()

process.on('SIGINT', () => {
  console.log('\n[codex] shutting down...')
  client.disconnect()
  process.exit(0)
})

process.on('SIGTERM', () => {
  client.disconnect()
  process.exit(0)
})

console.log(`[codex] starting — gateway=${GATEWAY_URL}, cwd=${CODEX_CWD}`)
