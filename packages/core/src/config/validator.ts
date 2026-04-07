import type { CompanyConfig } from '../types/company.ts'

export function validateCompanyConfig(config: CompanyConfig): readonly string[] {
  const errors: string[] = []

  // Validate project
  if (!config.project.name) {
    errors.push('project.name is required')
  }
  if (!config.project.repo) {
    errors.push('project.repo is required')
  }

  const agentIds = new Set(config.agents.map(a => a.id))

  // Validate agents
  if (config.agents.length === 0) {
    errors.push('At least one agent must be defined')
  }

  for (const agent of config.agents) {
    if (!agent.id) errors.push('Agent is missing an id')
    if (!agent.name) errors.push(`Agent "${agent.id}" is missing a name`)
    if (!agent.promptTemplate) errors.push(`Agent "${agent.id}" is missing a promptTemplate`)
    if (agent.capabilities.length === 0) {
      errors.push(`Agent "${agent.id}" has no capabilities`)
    }
  }

  // Validate workflow state references
  const stateIds = new Set(config.workflow.states.map(s => s.id))

  for (const transition of config.workflow.transitions) {
    if (!stateIds.has(transition.from)) {
      errors.push(`Transition references unknown state: "${transition.from}"`)
    }
    if (!stateIds.has(transition.to)) {
      errors.push(`Transition references unknown state: "${transition.to}"`)
    }
    if (transition.agentId && !agentIds.has(transition.agentId)) {
      errors.push(`Transition references unknown agent: "${transition.agentId}"`)
    }
    if (transition.fallbackState && !stateIds.has(transition.fallbackState)) {
      errors.push(`Transition fallbackState references unknown state: "${transition.fallbackState}"`)
    }
  }

  // Validate chain of command — agent references
  for (const node of config.chain.nodes) {
    if (!agentIds.has(node.agentId)) {
      errors.push(`Chain node references unknown agent: "${node.agentId}"`)
    }
    for (const target of node.dispatchesTo) {
      if (!agentIds.has(target)) {
        errors.push(`Chain node "${node.agentId}" dispatches to unknown agent: "${target}"`)
      }
    }
    if (node.reportsTo && !agentIds.has(node.reportsTo)) {
      errors.push(`Chain node "${node.agentId}" reports to unknown agent: "${node.reportsTo}"`)
    }
    for (const source of node.receivesFrom) {
      if (source.type === 'agent' && !agentIds.has(source.id)) {
        errors.push(`Chain node "${node.agentId}" receives from unknown agent: "${source.id}"`)
      }
    }
  }

  // Detect cycles in chain of command (DFS)
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const dispatchMap = new Map<string, readonly string[]>()

  for (const node of config.chain.nodes) {
    dispatchMap.set(node.agentId, node.dispatchesTo)
  }

  function hasCycle(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true
    if (visited.has(nodeId)) return false

    visited.add(nodeId)
    inStack.add(nodeId)

    for (const target of dispatchMap.get(nodeId) ?? []) {
      if (hasCycle(target)) return true
    }

    inStack.delete(nodeId)
    return false
  }

  for (const node of config.chain.nodes) {
    if (hasCycle(node.agentId)) {
      errors.push('Chain of command contains a cycle')
      break
    }
  }

  // Validate guardrails
  if (config.guardrails.maxFilesPerTask <= 0) {
    errors.push('guardrails.maxFilesPerTask must be positive')
  }
  if (config.guardrails.maxFileSizeBytes <= 0) {
    errors.push('guardrails.maxFileSizeBytes must be positive')
  }
  if (config.guardrails.maxTotalOutputBytes <= 0) {
    errors.push('guardrails.maxTotalOutputBytes must be positive')
  }

  // Validate costs
  if (config.costs.maxCostPerTask <= 0) {
    errors.push('costs.maxCostPerTask must be positive')
  }
  if (config.costs.maxCostPerDay <= 0) {
    errors.push('costs.maxCostPerDay must be positive')
  }
  if (config.costs.warnCostThreshold <= 0) {
    errors.push('costs.warnCostThreshold must be positive')
  }
  if (config.costs.warnCostThreshold > config.costs.maxCostPerTask) {
    errors.push('costs.warnCostThreshold should not exceed costs.maxCostPerTask')
  }

  return errors
}
