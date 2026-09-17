import type { CompanyConfig } from '../types/company.ts'
import type { GuardrailsConfig } from '../types/guardrails.ts'

/** The parts of a manifest that decide who may read its private sources. */
export type PrivateSourcePolicy = {
  readonly guardrails: Pick<GuardrailsConfig, 'privateSourceProviders'>
  readonly sources?: CompanyConfig['sources']
}

/** Whether the manifest trusts `provider` with its private sources. */
export function trustedWithPrivateSources(config: PrivateSourcePolicy, provider: string): boolean {
  return (config.guardrails.privateSourceProviders ?? []).includes(provider)
}

/**
 * The private source paths an agent on `provider` may not read.
 *
 * Empty for a trusted provider. For any other, every private source — so the
 * sandbox that runs the agent can deny them. This is enforcement by the
 * operating system, not by instruction: a prompt that says "do not read the
 * findings" is not a boundary.
 */
export function privateSourceDenials(config: PrivateSourcePolicy, provider: string): string[] {
  if (trustedWithPrivateSources(config, provider)) return []
  return Object.values(config.sources ?? {})
    .filter(s => s.visibility !== 'public' && typeof s.path === 'string' && s.path)
    .map(s => s.path)
}
