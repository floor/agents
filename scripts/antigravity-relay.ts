#!/usr/bin/env bun
/**
 * Antigravity committee relay — the PERSISTENT gateway client. Run this OUTSIDE
 * Antigravity (committee-run.ts spawns it; pm2 owns it in the daemon path).
 * Antigravity cycles its own background-task processes, so the long-lived gateway
 * connection must not live inside it.
 *
 * Logic lives in lib/relay.ts (testable); this is the runnable entry point.
 *
 *   GATEWAY_URL=ws://localhost:3199 bun scripts/antigravity-relay.ts
 */
import { createRelay } from './lib/relay.ts'

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://localhost:3199'

createRelay({
  gatewayUrl: GATEWAY_URL,
  ...(process.env.GATEWAY_TOKEN ? { token: process.env.GATEWAY_TOKEN } : {}),
  log: (msg) => console.log(`[relay] ${msg}`),
})

console.log(`[relay] connected to ${GATEWAY_URL}, holding the antigravity slot`)
