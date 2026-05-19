#!/usr/bin/env bun
/**
 * Codex external agent — connects to the Floor Agents gateway via WebSocket,
 * receives RFC review assignments, reviews them using OpenAI Codex, and
 * sends back votes.
 *
 * Usage:
 *   GATEWAY_URL=ws://localhost:3100 GATEWAY_TOKEN=secret bun scripts/codex-agent.ts
 */

import { createGatewayClient } from '@floor-agents/gateway'
import type { TaskAssignment } from '@floor-agents/gateway'

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://localhost:3100'
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required')
  process.exit(1)
}

async function reviewWithCodex(task: TaskAssignment): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'codex-mini-latest',
      instructions: task.systemPrompt,
      input: [
        `## Proposal: ${task.title}`,
        '',
        task.body,
        '',
        '---',
        'Review this proposal. Provide your technical analysis.',
        'End with exactly **VOTE: APPROVE** or **VOTE: REJECT**.',
      ].join('\n'),
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OpenAI API error ${response.status}: ${text}`)
  }

  const data = await response.json() as { output_text: string }
  return data.output_text
}

const client = createGatewayClient({
  url: GATEWAY_URL,
  agentId: 'codex',
  name: 'Codex (OpenAI)',
  capabilities: ['vote'],
  token: GATEWAY_TOKEN,
})

client.onTask(async (task) => {
  console.log(`\n[codex] reviewing: "${task.title}"`)
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

console.log(`[codex] starting — gateway=${GATEWAY_URL}`)
