#!/usr/bin/env bun
/**
 * Grok external agent — connects to the Floor Agents gateway via WebSocket,
 * receives RFC review assignments, reviews them with the LOCAL Grok CLI
 * (`grok --prompt-file …`, read-only sandbox, headless single-turn), and sends
 * back its vote.
 *
 * Grok replaces Antigravity as the third committee member: a CLI is a process we
 * fully control (assign → run → capture → vote), so the loop is event-driven with
 * no GUI session cycling and no polling.
 *
 * Prereq: `grok login` (the CLI must be authenticated).
 *
 * Usage:
 *   GATEWAY_URL=ws://localhost:3100 GROK_CWD=~/Code/floor/vlist bun scripts/grok-agent.ts
 */

import type { TaskAssignment } from '@floor-agents/gateway'
import { createGatewayClient } from '@floor-agents/gateway'
import { excerpt } from '@floor-agents/core'
import { buildGrokPrompt, buildGrokArgs } from './lib/grok.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://localhost:3100'
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN
const GROK_CWD = process.env.GROK_CWD ?? process.cwd()
const GROK_MODEL = process.env.GROK_MODEL // optional override (e.g. grok-4)
// Effort is OFF by default: the grok.com `grok-build` model rejects the
// reasoningEffort parameter (400). Only set GROK_EFFORT for a model that supports it.
const GROK_EFFORT = process.env.GROK_EFFORT
const GROK_SANDBOX = process.env.GROK_SANDBOX // optional sandbox profile override
const GROK_BIN = process.env.GROK_BIN ?? 'grok'

async function runGrok(prompt: string, boundedReadOnly: boolean): Promise<{ review: string; exitCode: number; stderr: string }> {
  const promptFile = join(tmpdir(), `grok-prompt-${crypto.randomUUID()}.md`)
  await Bun.write(promptFile, prompt)

  const args = buildGrokArgs({
    promptFile,
    cwd: GROK_CWD,
    ...(boundedReadOnly ? { boundedReadOnly: true } : {}),
    ...(GROK_EFFORT ? { effort: GROK_EFFORT } : {}),
    ...(GROK_MODEL ? { model: GROK_MODEL } : {}),
    ...(GROK_SANDBOX ? { sandbox: GROK_SANDBOX } : {}),
  })

  const proc = Bun.spawn([GROK_BIN, ...args], { stdout: 'pipe', stderr: 'pipe', cwd: GROK_CWD })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  await rm(promptFile, { force: true }).catch(() => {})
  return { review: stdout.trim(), exitCode, stderr }
}

async function reviewWithGrok(task: TaskAssignment): Promise<string> {
  const prompt = buildGrokPrompt(task)

  // First attempt: full tools (best grounding).
  const first = await runGrok(prompt, false)
  if (first.exitCode === 0 && first.review) return first.review

  // grok-build aborts a turn (exit 0, empty stdout) when read_file exceeds its
  // output cap. Retry once with a bounded read-only toolset (grep/list_dir, no
  // read_file) so it grounds without the too-large abort and reliably returns a vote.
  console.log(`[grok] empty/failed first pass (exit ${first.exitCode}) — retrying with bounded toolset`)
  const second = await runGrok(prompt, true)
  if (second.exitCode === 0 && second.review) return second.review

  const detail = excerpt(second.stderr || first.stderr, 1_000)
  throw new Error(`grok review produced no output after retry (exit ${second.exitCode}): ${detail}`)
}

const client = createGatewayClient({
  url: GATEWAY_URL,
  // The manifest's agent id, passed by the committee scripts; 'grok' otherwise.
  agentId: process.env.AGENT_ID ?? 'grok',
  name: 'Grok (local CLI)',
  capabilities: ['review_rfc', 'vote'],
  token: GATEWAY_TOKEN,
})

client.onTask(async (task) => {
  console.log(`\n[grok] reviewing: "${task.title}" (cwd=${GROK_CWD})`)
  const result = await reviewWithGrok(task)
  console.log(`[grok] review complete (${result.length} chars)`)
  return result
})

client.connect()

process.on('SIGINT', () => {
  console.log('\n[grok] shutting down...')
  client.disconnect()
  process.exit(0)
})

process.on('SIGTERM', () => {
  client.disconnect()
  process.exit(0)
})

console.log(`[grok] starting — gateway=${GATEWAY_URL}, cwd=${GROK_CWD}`)
