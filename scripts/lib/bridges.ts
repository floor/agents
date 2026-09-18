/**
 * Which bridge seats an external committee member, chosen by the manifest.
 *
 * `provider` names the transport. For an external agent it picks the bridge
 * script, and `model` is passed to it, so a project decides per agent whether
 * Grok comes through Cursor or through xAI's own CLI, and whether Gemini comes
 * through the Antigravity CLI (`agy`) on the Google subscription.
 *
 * A bridge also carries the private sources its provider is not trusted with.
 * The Cursor, Codex and Antigravity (`agy`) bridges run their CLI in a reviewer
 * sandbox that denies those paths. The xAI CLI runs uncontained, so a manifest
 * that does not trust that provider cannot seat it: the run is refused.
 *
 * `startExternalVoters` is the shared lifecycle: start a gateway if none is
 * running, spawn each external voter's bridge, wait for it to register, and
 * return a session the caller stops when the votes are in. A bridge that
 * cannot start is recorded as a failure so the member can abstain immediately
 * instead of polling issue comments.
 */

import type { AgentDefinition, PrivateSourcePolicy } from '@floor-agents/core'
import { privateSourceDenials } from '@floor-agents/core'
import { denyReadEnv } from '@floor-agents/sandbox'
import { createGateway, type Gateway, type GatewayConfig } from '@floor-agents/gateway'
import { join } from 'node:path'
import { trackChild } from '../../packages/orchestrator/src/lifecycle.ts'

export type BridgePlan = {
  readonly script: string
  readonly env: Readonly<Record<string, string>>
}

/** Transports that run as a bridge on the gateway. */
export const BRIDGE_PROVIDERS = ['cursor', 'codex-cli', 'grok-cli', 'antigravity'] as const

/**
 * Manifests written before `provider` picked the bridge named a vendor there
 * (`openai`, `gemini`) and relied on the agent id. Those ids still resolve.
 */
const LEGACY_BY_ID: Readonly<Record<string, (typeof BRIDGE_PROVIDERS)[number]>> = {
  codex: 'codex-cli',
  grok: 'grok-cli',
  antigravity: 'antigravity',
}

type Agent = Pick<AgentDefinition, 'id' | 'name' | 'llm' | 'external' | 'voteByComment'>

const modelEnv = (name: string, model: string): Record<string, string> =>
  model && model !== 'local' ? { [name]: model } : {}

/** FLOOR_AGENTS_DENY_READ for the bridge, when there is anything to deny. */
const denyEnv = (denyRead: readonly string[], env: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const value = denyRead.length ? denyReadEnv(denyRead, env) : undefined
  return value ? { FLOOR_AGENTS_DENY_READ: value } : {}
}

export function bridgeFor(
  agent: Agent,
  repo: string,
  denyRead: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = process.env,
): BridgePlan {
  const provider = (BRIDGE_PROVIDERS as readonly string[]).includes(agent.llm.provider)
    ? (agent.llm.provider as (typeof BRIDGE_PROVIDERS)[number])
    : LEGACY_BY_ID[agent.id]
  switch (provider) {
    case 'cursor':
      if (!agent.llm.model || agent.llm.model === 'local') {
        throw new Error(`Agent "${agent.id}" uses provider cursor but names no model; set llm.model (e.g. cursor-grok-4.6-high)`)
      }
      return {
        script: 'cursor-agent-bridge.ts',
        env: { AGENT_ID: agent.id, AGENT_NAME: agent.name, CURSOR_MODEL: agent.llm.model, REVIEW_CWD: repo, ...denyEnv(denyRead, env) },
      }
    case 'codex-cli':
      return {
        script: 'codex-agent.ts',
        env: { AGENT_ID: agent.id, CODEX_CWD: repo, ...modelEnv('CODEX_MODEL', agent.llm.model), ...denyEnv(denyRead, env) },
      }
    case 'antigravity':
      if (!agent.llm.model || agent.llm.model === 'local') {
        throw new Error(`Agent "${agent.id}" uses provider antigravity but names no model; set llm.model (e.g. gemini-3.1-pro-high)`)
      }
      return {
        script: 'agy-agent-bridge.ts',
        env: { AGENT_ID: agent.id, AGENT_NAME: agent.name, AGY_MODEL: agent.llm.model, REVIEW_CWD: repo, ...denyEnv(denyRead, env) },
      }
    case 'grok-cli':
      if (denyRead.length) {
        throw new Error(
          `Agent "${agent.id}" (provider ${provider}) may not read this project's private sources, ` +
          'and its bridge cannot be sandboxed to stop it. Seat it through a contained bridge ' +
          '(cursor, codex-cli, antigravity) or add its provider to guardrails.privateSourceProviders.',
        )
      }
      return { script: 'grok-agent.ts', env: { AGENT_ID: agent.id, GROK_CWD: repo, ...modelEnv('GROK_MODEL', agent.llm.model) } }
    default:
      throw new Error(
        `No bridge for external agent "${agent.id}" (provider "${agent.llm.provider}"). ` +
        `Use one of: ${BRIDGE_PROVIDERS.join(', ')}.`,
      )
  }
}

/** How long to wait for a spawned bridge to register on the gateway. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

export type SpawnedBridge = {
  readonly kill: () => void
  readonly exited: Promise<number>
  readonly exitCode: number | null
}

export type SpawnBridge = (script: string, env: Record<string, string | undefined>) => SpawnedBridge

export type ExternalVoterStart =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

export type ExternalVoterSession = {
  readonly gateway: Gateway
  readonly started: ReadonlyMap<string, ExternalVoterStart>
  stop(): void
}

export type StartExternalVotersOpts = {
  readonly port: number
  readonly repo: string
  readonly log: (msg: string) => void
  /** The manifest, whose private sources each bridge must deny to an untrusted provider. */
  readonly manifest: PrivateSourcePolicy
  /** Reuse a gateway that is already running (watch mode). Absent: one is started and stopped with the session. */
  readonly gateway?: Gateway
  /** For tests: the gateway constructor, instead of opening a real port. */
  readonly createGateway?: (config: GatewayConfig) => Gateway
  /** For tests: the process spawn, instead of `bun scripts/<bridge>`. */
  readonly spawn?: SpawnBridge
  /** How long to wait for each bridge to register. */
  readonly connectTimeoutMs?: number
}

function defaultSpawn(script: string, env: Record<string, string | undefined>): SpawnedBridge {
  // Its own process group: a bridge runs a reviewer CLI, and ending the bridge
  // alone left that CLI reviewing for nobody.
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', script)], {
    env,
    stdout: 'inherit',
    stderr: 'inherit',
    detached: process.platform !== 'win32',
  })
  trackChild(proc, proc.exited)
  return {
    exited: proc.exited,
    get exitCode() { return proc.exitCode },
    kill() {
      try {
        if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGTERM')
        else proc.kill()
      } catch { proc.kill() }
    },
  }
}

async function waitForConnect(
  gateway: Gateway,
  agentId: string,
  proc: SpawnedBridge,
  timeoutMs: number,
): Promise<ExternalVoterStart> {
  const deadline = Date.now() + timeoutMs
  let exited: number | undefined
  const watchExit = proc.exited.then(code => { exited = code })
  while (Date.now() < deadline) {
    if (gateway.isAgentConnected(agentId)) return { ok: true }
    if (proc.exitCode !== null || exited !== undefined) {
      const code = proc.exitCode ?? exited
      return { ok: false, reason: `bridge process exited (code ${code})` }
    }
    const remaining = Math.max(0, deadline - Date.now())
    await Promise.race([
      watchExit,
      new Promise<void>(r => setTimeout(r, Math.min(50, remaining))),
    ])
  }
  if (gateway.isAgentConnected(agentId)) return { ok: true }
  return { ok: false, reason: `bridge did not connect within ${timeoutMs}ms` }
}

function needsBridge(agent: Agent): boolean {
  return !!agent.external && !agent.voteByComment
}

/**
 * Start a gateway if none is running, spawn a bridge for every external voter
 * that is not configured to vote by comment, and wait for each to register.
 *
 * A member whose bridge cannot start (CLI missing, login expired, unknown
 * provider) is recorded as a failure so the caller can abstain immediately.
 * `stop()` kills the processes this session spawned, and stops a gateway this
 * session started. A gateway the caller passed in is left running.
 */
export async function startExternalVoters(
  agents: readonly Agent[],
  opts: StartExternalVotersOpts,
): Promise<ExternalVoterSession> {
  const toStart = agents.filter(needsBridge)
  const ownedGateway = !opts.gateway
  // A gateway this review starts is its own: any free port. Two `run`s at once
  // both asked for the configured port, and the second review lost its external
  // seats ("Is port 3100 in use?" — mtrl #92). The configured port is for the
  // long-lived gateway of `watch`, which people and other tools connect to.
  const gateway = opts.gateway ?? (opts.createGateway ?? createGateway)({
    port: 0,
    ...(process.env.GATEWAY_TOKEN ? { token: process.env.GATEWAY_TOKEN } : {}),
  })
  if (ownedGateway) gateway.start()
  const port = gateway.getPort?.() ?? opts.port

  const started = new Map<string, ExternalVoterStart>()
  const live: SpawnedBridge[] = []
  const spawn = opts.spawn ?? defaultSpawn
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

  for (const agent of toStart) {
    let plan: BridgePlan
    try {
      plan = bridgeFor(agent, opts.repo, privateSourceDenials(opts.manifest, agent.llm.provider))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      opts.log(`${agent.id}: ${reason}`)
      started.set(agent.id, { ok: false, reason })
      continue
    }

    let proc: SpawnedBridge
    try {
      proc = spawn(plan.script, { ...process.env, GATEWAY_URL: `ws://localhost:${port}`, ...plan.env })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      opts.log(`${agent.id} via ${plan.script}: ${reason}`)
      started.set(agent.id, { ok: false, reason })
      continue
    }

    const outcome = await waitForConnect(gateway, agent.id, proc, connectTimeoutMs)
    if (outcome.ok) {
      live.push(proc)
      started.set(agent.id, { ok: true })
      opts.log(`${agent.id} via ${plan.script} connected`)
    } else {
      proc.kill()
      started.set(agent.id, outcome)
      opts.log(`${agent.id} via ${plan.script} failed: ${outcome.reason}`)
    }
  }

  return {
    gateway,
    started,
    stop() {
      for (const p of live) p.kill()
      if (ownedGateway) gateway.stop()
    },
  }
}

/**
 * Start a bridge for every external member and wait for each to register.
 * A wrapper around {@link startExternalVoters} for callers that already hold
 * a gateway (RFC scripts). Failed members are logged and skipped; the session
 * still stops the processes that did start.
 */
export async function startBridges(
  agents: readonly Agent[],
  opts: {
    readonly port: number
    readonly repo: string
    readonly gateway: Gateway
    readonly log: (msg: string) => void
    /** The manifest, whose private sources each bridge must deny to an untrusted provider. */
    readonly manifest: PrivateSourcePolicy
  },
): Promise<{ stop(): void }> {
  const session = await startExternalVoters(agents, opts)
  return { stop: () => session.stop() }
}
