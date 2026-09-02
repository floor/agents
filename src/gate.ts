// Review & gate mode entry point: watches open PRs on configured repos
// this process did not create, drives an independent-vendor Reviewer, and
// merges once the gate decides a PR is mergeable. See docs/review-gate.md.
//
// Usage: bun run gate   (or: bun run src/gate.ts)

import { mkdir } from 'node:fs/promises'
import { createGitHubAdapter } from '@floor-agents/github'
import { createGateStateStore, loadGateConfig, startGateLoop } from '@floor-agents/orchestrator'
import { createReviewer } from './gate/create-reviewer.ts'

const GATE_CONFIG_PATH = process.env.GATE_CONFIG_PATH ?? 'config/gate/gate.example.yaml'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const config = await loadGateConfig(GATE_CONFIG_PATH)

const git = createGitHubAdapter({
  token: requireEnv('GITHUB_TOKEN'),
  owner: requireEnv('GITHUB_OWNER'),
})

await mkdir(config.stateDir, { recursive: true })

const reviewer = createReviewer()

console.log('[gate] starting')
console.log(`  repos:    ${config.repos.join(', ')}`)
console.log(`  reviewer: ${reviewer.vendor}`)
console.log(`  interval: ${config.pollIntervalMs}ms`)
console.log(`  merge:    ${config.mergeEnabled ? 'ENABLED' : 'dry run (default)'}`)
console.log()

const handle = startGateLoop({
  git,
  reviewer,
  gateStateStore: createGateStateStore(config.stateDir),
  config,
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[gate] received ${signal}, stopping...`)
    handle.stop()
    process.exit(0)
  })
}
