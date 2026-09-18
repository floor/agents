import type { CompanyConfig } from '@floor-agents/core'

/**
 * Which Linear project an engine process reads: the one its manifest names.
 *
 * The environment is only the fallback for a manifest that names none. It used
 * to win. An engine started from a folder whose `.env` set `LINEAR_PROJECT_ID`
 * read that project's issues whatever its manifest said — measured on 2026-09-18:
 * the API of the mtrl engine listed the agents project's backlog, and a watcher
 * started that way would have run those issues against the mtrl repository.
 */
export function linearScope(
  company: Pick<CompanyConfig, 'tasks'>,
  env: Readonly<Record<string, string | undefined>>,
): { readonly projectName: string } | { readonly projectId: string } | Record<string, never> {
  const named = company.tasks?.linear?.project
  if (named) return { projectName: named }
  return env.LINEAR_PROJECT_ID ? { projectId: env.LINEAR_PROJECT_ID } : {}
}
