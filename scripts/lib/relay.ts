/** Persistent Antigravity gateway client (the relay core). */
import { createGatewayClient } from '@floor-agents/gateway'
import type { TaskAssignment } from '@floor-agents/gateway'
import { committeeFiles, safe, type CommitteeFiles } from './committee-files.ts'

export type Relay = {
  readonly files: CommitteeFiles
  stop(): void
}

export type RelayOptions = {
  readonly gatewayUrl: string
  readonly token?: string
  readonly base?: string
  readonly log?: (msg: string) => void
  readonly pollMs?: number
}

/**
 * Connect to the gateway as agent `antigravity`. On assignment, write the task to
 * pending/; poll results/ and forward votes back to the gateway. Runs OUTSIDE
 * Antigravity (which cycles its own processes), so the gateway connection is stable.
 */
export function createRelay(opts: RelayOptions): Relay {
  const log = opts.log ?? (() => {})
  const files = committeeFiles(opts.base)
  const waiters = new Map<string, (content: string) => void>()

  const client = createGatewayClient({
    url: opts.gatewayUrl,
    agentId: 'antigravity',
    name: 'Antigravity (Gemini)',
    capabilities: ['review_rfc', 'vote'],
    ...(opts.token ? { token: opts.token } : {}),
  })

  client.onTask((task: TaskAssignment) => {
    files.writePending(task)
    log(`pending review ${task.id} — notify will wake Antigravity`)
    return new Promise<string>((resolve) => { waiters.set(safe(task.id), resolve) })
  })

  client.connect()

  function tryForward(name: string): void {
    const sid = name.replace(/\.json$/, '')
    const resolve = waiters.get(sid)
    if (!resolve) return
    const result = files.readResult(name)
    if (!result) return // mid-write; next poll catches it
    waiters.delete(sid)
    files.clear(sid)
    resolve(result.content)
    log(`forwarded vote for ${sid} (${result.content.length} chars)`)
  }

  const timer = setInterval(() => {
    for (const f of files.resultFiles()) tryForward(f)
  }, opts.pollMs ?? 400)

  return {
    files,
    stop() { clearInterval(timer); client.disconnect() },
  }
}
