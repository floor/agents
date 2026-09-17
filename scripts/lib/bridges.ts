/**
 * Which bridge seats an external committee member, chosen by the manifest.
 *
 * `provider` names the transport. For an external agent it picks the bridge
 * script, and `model` is passed to it, so a project decides per agent whether
 * Grok comes through Cursor or through xAI's own CLI.
 *
 * A bridge also carries the private sources its provider is not trusted with.
 * The Cursor and Codex bridges run their CLI in a reviewer sandbox that denies
 * those paths. The xAI CLI and Antigravity run uncontained, so a manifest that
 * does not trust their provider cannot seat them: the run is refused.
 */

import type { AgentDefinition, PrivateSourcePolicy } from '@floor-agents/core'
import { privateSourceDenials } from '@floor-agents/core'
import { denyReadEnv } from '@floor-agents/sandbox'
import type { Gateway } from '@floor-agents/gateway'
import { join } from 'node:path'

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

type Agent = Pick<AgentDefinition, 'id' | 'name' | 'llm' | 'external'>

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
    case 'grok-cli':
    case 'antigravity':
      if (denyRead.length) {
        throw new Error(
          `Agent "${agent.id}" (provider ${provider}) may not read this project's private sources, ` +
          'and its bridge cannot be sandboxed to stop it. Seat it through a contained bridge ' +
          '(cursor, codex-cli) or add its provider to guardrails.privateSourceProviders.',
        )
      }
      if (provider === 'antigravity') return { script: 'antigravity-relay.ts', env: {} }
      return { script: 'grok-agent.ts', env: { AGENT_ID: agent.id, GROK_CWD: repo, ...modelEnv('GROK_MODEL', agent.llm.model) } }
    default:
      throw new Error(
        `No bridge for external agent "${agent.id}" (provider "${agent.llm.provider}"). ` +
        `Use one of: ${BRIDGE_PROVIDERS.join(', ')}.`,
      )
  }
}

/**
 * Start a bridge for every external member and wait for each to register.
 * Plans are resolved before anything spawns, so a bad provider fails the run
 * before a single process starts.
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
  const external = agents.filter(a => a.external)
  const plans = external.map(a => ({ agent: a, plan: bridgeFor(a, opts.repo, privateSourceDenials(opts.manifest, a.llm.provider)) }))
  const procs = plans.map(({ plan }) =>
    Bun.spawn(['bun', join(import.meta.dir, '..', plan.script)], {
      env: { ...process.env, GATEWAY_URL: `ws://localhost:${opts.port}`, ...plan.env },
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  )
  for (const { agent, plan } of plans) {
    for (let i = 0; i < 30 && !opts.gateway.isAgentConnected(agent.id); i++) await new Promise(r => setTimeout(r, 500))
    opts.log(`${agent.id} via ${plan.script} connected: ${opts.gateway.isAgentConnected(agent.id)}`)
  }
  return { stop: () => { for (const p of procs) p.kill() } }
}
