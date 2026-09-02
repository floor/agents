// Review & gate mode entry point: watches open PRs on configured repos
// this process did not create, drives an independent-vendor Reviewer, and
// merges once the gate decides a PR is mergeable. See docs/review-gate.md.
//
// Usage: bun run gate   (or: bun run src/gate.ts)

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createFakeReviewer, type Reviewer } from '@floor-agents/core'
import { createGitHubAdapter } from '@floor-agents/github'
import { createGateStateStore, loadGateConfig, startGateLoop } from '@floor-agents/orchestrator'

const GATE_CONFIG_PATH = process.env.GATE_CONFIG_PATH ?? 'config/gate/gate.example.yaml'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

/** Runs the exact command the review-and-gate protocol documents
 *  (floor/radiooooo AGENTS.md, "Review" section): `codex exec --sandbox
 *  read-only "<prompt>" < /dev/null`. A separate @floor-agents/codex-cli
 *  package (built independently against the Reviewer interface) is
 *  expected to supersede this inline glue once available — swap it in
 *  below rather than extending this function. */
function createInlineCodexReviewer(): Reviewer {
  return {
    vendor: 'codex',
    async review({ prompt }) {
      const text = await new Promise<string>((resolve, reject) => {
        const child = spawn('codex', ['exec', '--sandbox', 'read-only', prompt], {
          stdio: ['ignore', 'pipe', 'inherit'], // stdin ignored == < /dev/null
        })
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
        child.on('error', reject)
        child.on('close', code => {
          if (code !== 0) reject(new Error(`codex exec exited with code ${code}`))
          else resolve(out)
        })
      })
      return { text: text.trim() }
    },
  }
}

function createReviewer(): Reviewer {
  const kind = process.env.GATE_REVIEWER ?? 'codex'
  switch (kind) {
    case 'codex':
      return createInlineCodexReviewer()
    case 'fake':
      // Smoke-test the loop end-to-end without shelling out to a real reviewer.
      return createFakeReviewer({ vendor: 'fake' })
    default:
      throw new Error(
        `Unknown GATE_REVIEWER "${kind}". Supported: codex, fake. ` +
        `Wire in another Reviewer implementation (e.g. @floor-agents/codex-cli) here once available.`,
      )
  }
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
