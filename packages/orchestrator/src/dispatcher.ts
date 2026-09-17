import type { AgentDefinition, Issue } from '@floor-agents/core'

export function resolveAgent(
  issue: Issue,
  agents: readonly AgentDefinition[],
): AgentDefinition | null {
  // Match by issue label → agent id
  for (const label of issue.labels) {
    const match = agents.find(a => a.id === label && a.capabilities.includes('write_code') && !a.external)
    if (match) return match
  }

  // Fallback: first agent with write_code capability
  const writer = agents.find(a => a.capabilities.includes('write_code') && !a.external)
  if (writer) return writer

  return null
}
