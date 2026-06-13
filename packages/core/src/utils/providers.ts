import type { AgentDefinition } from '../types/agent.ts'

/**
 * The set of LLM providers that need an in-process adapter (and thus an API key).
 *
 * External agents (Codex, Antigravity, …) run via the gateway rather than an
 * in-process LLM adapter, so their `llm.provider` is excluded — they require no
 * API key.
 */
export function computeRequiredProviders(agents: readonly AgentDefinition[]): Set<string> {
  return new Set(agents.filter(a => !a.external).map(a => a.llm.provider))
}
