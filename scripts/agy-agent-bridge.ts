#!/usr/bin/env bun
/**
 * Antigravity committee bridge — Gemini through `agy` as a committee member.
 *
 * Connects to the gateway under the manifest's agent id, receives review
 * assignments, runs `agy -p --mode plan` against the repository with the model
 * the manifest names, and returns the review. It runs on the Google AI Pro
 * subscription, so there is no API key and no per-call metering.
 *
 * Every review runs inside a reviewer sandbox: the agent reads the repository
 * but cannot write anything outside its tool state, and cannot read credential
 * stores or .env files. The CLI's own `--sandbox` is not relied on.
 *
 * Started by the committee scripts for agents with `provider: antigravity`:
 *   GATEWAY_URL=ws://localhost:3199 AGENT_ID=gemini AGY_MODEL=gemini-3.1-pro-high \
 *   REVIEW_CWD=~/Code/floor/vlist bun scripts/agy-agent-bridge.ts
 */

import { createGatewayClient } from '@floor-agents/gateway'
import { createAntigravityAdapter } from '@floor-agents/antigravity'
import { reviewerSandbox } from '@floor-agents/sandbox'
import { buildCursorReviewPrompt, reviewWithRetry } from './lib/cursor-review.ts'

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    console.error(`[agy-bridge] ${name} is required`)
    process.exit(1)
  }
  return value
}

const AGENT_ID = required('AGENT_ID')
const MODEL = required('AGY_MODEL')
const CWD = process.env.REVIEW_CWD ?? process.cwd()
const tag = `[${AGENT_ID}]`

const adapter = createAntigravityAdapter({
  cwd: CWD,
  model: MODEL,
  role: 'review',
  sandbox: reviewerSandbox('antigravity'),
  ...(process.env.EXTERNAL_TIMEOUT_MS ? { timeoutMs: Number(process.env.EXTERNAL_TIMEOUT_MS) } : {}),
})

const client = createGatewayClient({
  url: process.env.GATEWAY_URL ?? 'ws://localhost:3100',
  agentId: AGENT_ID,
  name: process.env.AGENT_NAME ?? `${AGENT_ID} (Antigravity)`,
  capabilities: ['review_rfc', 'vote'],
  token: process.env.GATEWAY_TOKEN,
})

client.onTask(async (task) => {
  console.log(`\n${tag} reviewing: "${task.title}" (model=${MODEL}, cwd=${CWD}, sandboxed)`)
  const prompt = buildCursorReviewPrompt(task)
  const review = await reviewWithRetry(
    async () => (await adapter.run({ provider: 'antigravity', model: MODEL, system: '', messages: [{ role: 'user', content: prompt }] })).content,
    msg => console.log(`${tag} ${msg}`),
  )
  console.log(`${tag} review complete (${review.length} chars)`)
  return review
})

client.connect()

const stop = () => {
  client.disconnect()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

console.log(`${tag} starting — model=${MODEL}, cwd=${CWD}`)
