import { test, expect, describe, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGateway, type Gateway } from '@floor-agents/gateway'
import { createRelay, type Relay } from '../../scripts/lib/relay.ts'
import { submitVote } from '../../scripts/lib/mcp-tools.ts'

const PORT = 9788
let gateway: Gateway | null = null
let relay: Relay | null = null
let base: string | null = null

afterEach(() => {
  relay?.stop(); relay = null
  gateway?.stop(); gateway = null
  if (base) { rmSync(base, { recursive: true, force: true }); base = null }
})

async function until(pred: () => boolean, ms = 5000): Promise<boolean> {
  for (let i = 0; i < ms / 25 && !pred(); i++) await new Promise(r => setTimeout(r, 25))
  return pred()
}

function start() {
  base = mkdtempSync(join(tmpdir(), 'relay-'))
  gateway = createGateway({ port: PORT })
  gateway.start()
  relay = createRelay({ gatewayUrl: `ws://localhost:${PORT}`, base, pollMs: 50 })
  return { gateway, relay, base }
}

const assignment = (id = 'rfc:antigravity') => ({
  id, issueId: 'rfc', title: 'RFC-013', body: 'proposal', systemPrompt: 'browser lens',
  createdAt: new Date().toISOString(),
})

describe('relay', () => {
  test('connects to the gateway as antigravity', async () => {
    const { gateway } = start()
    expect(await until(() => gateway.isAgentConnected('antigravity'))).toBe(true)
  })

  test('writes the assignment to pending on dispatch', async () => {
    const { gateway, relay } = start()
    await until(() => gateway.isAgentConnected('antigravity'))
    gateway.assign('antigravity', assignment())
    expect(await until(() => relay.files.oldestPending() !== null)).toBe(true)
    expect(relay.files.oldestPending()!.title).toBe('RFC-013')
  })

  test('forwards a submitted vote back to the gateway and clears its files', async () => {
    const { gateway, relay } = start()
    await until(() => gateway.isAgentConnected('antigravity'))

    const resultP = gateway.waitForResult('rfc:antigravity', 5000)
    gateway.assign('antigravity', assignment())
    await until(() => relay.files.oldestPending() !== null)

    // Simulate Antigravity reviewing via the file-backed MCP server.
    submitVote(relay.files, 'rfc:antigravity', 'sound analysis\n\nVOTE: REJECT')

    const result = await resultP
    expect(result.agentId).toBe('antigravity')
    expect(result.content).toContain('VOTE: REJECT')

    // pending + result cleaned up after a successful forward
    expect(await until(() => relay.files.pendingSids().length === 0)).toBe(true)
    expect(relay.files.resultFiles()).toEqual([])
  })
})
