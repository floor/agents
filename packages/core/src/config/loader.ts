import { parse } from 'yaml'
import type { CompanyConfig } from '../types/company.ts'
import type { AgentDefinition, AgentCapability, AutonomyTier } from '../types/agent.ts'
import type { ProjectConfig } from '../types/project.ts'
import type { WorkflowDefinition } from '../types/workflow.ts'
import type { ChainOfCommand } from '../types/chain.ts'
import type { AutonomyConfig } from '../types/autonomy.ts'
import type { GuardrailsConfig } from '../types/guardrails.ts'
import type { CostConfig } from '../types/costs.ts'

const DEFAULT_TEMPLATE_PATH = 'config/templates/default.yaml'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function parseAgents(raw: unknown[]): AgentDefinition[] {
  return raw.map((a: any) => ({
    id: a.id,
    name: a.name,
    promptTemplate: a.promptTemplate,
    llm: {
      provider: a.llm.provider,
      model: a.llm.model,
      temperature: a.llm.temperature ?? 0.2,
      maxTokens: a.llm.maxTokens ?? 4000,
    },
    capabilities: a.capabilities as AgentCapability[],
    autonomy: (a.autonomy ?? 'T1') as AutonomyTier,
    customInstructions: a.customInstructions ?? '',
  }))
}

function parseProject(raw: any): ProjectConfig {
  return {
    name: raw.name ?? '',
    repo: raw.repo ?? '',
    language: raw.language ?? '',
    runtime: raw.runtime ?? '',
    conventions: raw.conventions ?? {},
    structure: raw.structure ?? {},
    packages: raw.packages ?? [],
    customInstructions: raw.customInstructions ?? '',
  }
}

function parseWorkflow(raw: any): WorkflowDefinition {
  return {
    states: (raw?.states ?? []).map((s: any) => ({
      id: s.id,
      label: s.label,
      taskManagerStatus: s.taskManagerStatus,
      terminal: s.terminal ?? false,
    })),
    transitions: (raw?.transitions ?? []).map((t: any) => ({
      from: t.from,
      to: t.to,
      trigger: t.trigger,
      agentId: t.agentId ?? null,
      maxCycles: t.maxCycles ?? null,
      fallbackState: t.fallbackState ?? null,
    })),
  }
}

function parseChain(raw: any): ChainOfCommand {
  return {
    nodes: (raw?.nodes ?? []).map((n: any) => ({
      agentId: n.agentId,
      receivesFrom: n.receivesFrom ?? [],
      dispatchesTo: n.dispatchesTo ?? [],
      reportsTo: n.reportsTo ?? null,
      canApprove: n.canApprove ?? false,
      canReject: n.canReject ?? false,
    })),
  }
}

function parseAutonomy(raw: any): AutonomyConfig {
  return {
    default: (raw?.default ?? 'T1') as AutonomyTier,
    overrides: (raw?.overrides ?? []).map((o: any) => ({
      match: o.match ?? {},
      tier: o.tier as AutonomyTier,
    })),
  }
}

function parseGuardrails(raw: any): GuardrailsConfig {
  return {
    maxFilesPerTask: raw?.maxFilesPerTask ?? 20,
    maxFileSizeBytes: raw?.maxFileSizeBytes ?? 102400,
    maxTotalOutputBytes: raw?.maxTotalOutputBytes ?? 512000,
    blockedPaths: raw?.blockedPaths ?? [],
    allowedPaths: raw?.allowedPaths ?? [],
    blockedExtensions: raw?.blockedExtensions ?? [],
  }
}

function parseCosts(raw: any): CostConfig {
  return {
    maxCostPerTask: raw?.maxCostPerTask ?? 5.0,
    maxCostPerDay: raw?.maxCostPerDay ?? 50.0,
    warnCostThreshold: raw?.warnCostThreshold ?? 2.0,
  }
}

export async function loadCompanyConfig(path?: string): Promise<CompanyConfig> {
  const configPath = path ?? DEFAULT_TEMPLATE_PATH
  const file = Bun.file(configPath)

  if (!await file.exists()) {
    if (path) {
      throw new Error(`Config file not found: ${configPath}`)
    }
    // Fall back to default template
    const defaultFile = Bun.file(DEFAULT_TEMPLATE_PATH)
    if (!await defaultFile.exists()) {
      throw new Error(`Default template not found: ${DEFAULT_TEMPLATE_PATH}`)
    }
    const text = await defaultFile.text()
    return parseConfig(text)
  }

  const text = await file.text()
  return parseConfig(text)
}

function parseConfig(text: string): CompanyConfig {
  const raw = parse(text)
  const now = new Date()
  const name = raw.name ?? 'Unnamed'

  return {
    id: slugify(name),
    name,
    project: parseProject(raw.project ?? {}),
    agents: parseAgents(raw.agents ?? []),
    workflow: parseWorkflow(raw.workflow),
    chain: parseChain(raw.chain),
    autonomy: parseAutonomy(raw.autonomy),
    guardrails: parseGuardrails(raw.guardrails),
    costs: parseCosts(raw.costs),
    statusMapping: raw.statusMapping ?? {},
    createdAt: now,
    updatedAt: now,
  }
}
