#!/usr/bin/env bun
/**
 * Bare gateway listener — diagnostic. Starts the gateway and logs agent
 * connect/disconnect, so you can confirm an external bridge (Codex/Antigravity)
 * reaches it before running a real committee round. No LLM spend.
 *
 *   GATEWAY_PORT=3199 bun scripts/gateway-listen.ts
 */
import { createGateway } from '@floor-agents/gateway'

const PORT = parseInt(process.env.GATEWAY_PORT ?? '3199', 10)
const gateway = createGateway({ port: PORT })

gateway.onAgentConnect((a) => console.log(`✅ connected: ${a.agentId} (${a.name}) [${a.capabilities.join(', ')}]`))
gateway.onAgentDisconnect((id) => console.log(`❌ disconnected: ${id}`))

gateway.start()
console.log(`[listen] gateway up on :${PORT} — waiting for agents (Ctrl-C to stop)`)

process.on('SIGINT', () => { gateway.stop(); process.exit(0) })
process.on('SIGTERM', () => { gateway.stop(); process.exit(0) })
