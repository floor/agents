import type { AgentDefinition } from '@floor-agents/core'

/**
 * Which pipelines a manifest runs, decided by the roles its agents hold.
 *
 * A manifest used to switch wholesale into committee mode the moment any one
 * agent could vote, so the agents that implement and the agents that review
 * could not share a file. Now each role brings its own pipeline: voters bring
 * the committee, implementers bring development, and a manifest holding both
 * runs both.
 *
 * A manifest with no voters keeps its old behaviour and runs development even
 * without an implementer, which is how a PM-only team has always started.
 */
export type Pipelines = {
  readonly development: boolean
  readonly committee: boolean
}

type Agent = Pick<AgentDefinition, 'capabilities' | 'external'>

export function pipelinesFor(agents: readonly Agent[]): Pipelines {
  const committee = agents.some(a => a.capabilities.includes('vote'))
  const implementer = agents.some(a => a.capabilities.includes('write_code') && !a.external)
  return { development: !committee || implementer, committee }
}

/** The startup banner's name for the pipelines that run. */
export function pipelinesLabel(p: Pipelines): string {
  return [p.development ? 'dev' : '', p.committee ? 'committee' : ''].filter(Boolean).join(' + ')
}
