// Review & gate mode entry point: watches open PRs on configured repos
// this process did not create, drives an independent-vendor Reviewer, and
// merges once the gate decides a PR is mergeable. See docs/review-gate.md.
//
// Usage: bun run gate   (or: bun run src/gate.ts)

import { mkdir } from 'node:fs/promises'
import { createFakeReviewer, type Reviewer } from '@floor-agents/core'
import { createCodexReviewer, type CodexReviewerConfig } from '@floor-agents/codex-cli'
import { createGitHubAdapter } from '@floor-agents/github'
import { createGateStateStore, loadGateConfig, startGateLoop } from '@floor-agents/orchestrator'

const GATE_CONFIG_PATH = process.env.GATE_CONFIG_PATH ?? 'config/gate/gate.example.yaml'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

/** Builds `@floor-agents/codex-cli`'s `CodexReviewerConfig` from environment
 *  variables. Every key is optional — an unset var leaves the package's own
 *  default in place (see packages/codex-cli/README.md's Options table).
 *  Note `GATE_CODEX_CLONE_PATH` is optional here only in the sense that the
 *  package itself doesn't require it at construction time — the gate loop
 *  always calls `reviewer.review()` without a `worktreePath`, so in
 *  practice `clonePath` must be set for `codex` review to actually run; an
 *  unset one surfaces as a clear error from the package the first time a
 *  review is attempted, not a silent no-op. */
function codexReviewerConfigFromEnv(env: Record<string, string | undefined> = process.env): CodexReviewerConfig {
  const config: { -readonly [K in keyof CodexReviewerConfig]?: CodexReviewerConfig[K] } = {}

  if (env.GATE_CODEX_BINARY !== undefined) config.binary = env.GATE_CODEX_BINARY
  if (env.GATE_CODEX_MODEL !== undefined) config.model = env.GATE_CODEX_MODEL
  if (env.GATE_CODEX_PROFILE !== undefined) config.profile = env.GATE_CODEX_PROFILE
  if (env.GATE_CODEX_CLONE_PATH !== undefined) config.clonePath = env.GATE_CODEX_CLONE_PATH
  if (env.GATE_CODEX_WORKTREE_ROOT !== undefined) config.worktreeRoot = env.GATE_CODEX_WORKTREE_ROOT

  if (env.GATE_CODEX_TIMEOUT_MS !== undefined) {
    const timeoutMs = Number(env.GATE_CODEX_TIMEOUT_MS)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `GATE_CODEX_TIMEOUT_MS must be a positive number — got ${JSON.stringify(env.GATE_CODEX_TIMEOUT_MS)}`,
      )
    }
    config.timeoutMs = timeoutMs
  }

  return config
}

function createReviewer(): Reviewer {
  const kind = process.env.GATE_REVIEWER ?? 'codex'
  switch (kind) {
    case 'codex':
      // Wired directly to the @floor-agents/codex-cli package's Reviewer
      // implementation — see packages/codex-cli/README.md for the exact
      // invocation contract (fixed argv, worktree lifecycle, the
      // "## Reviewer agent (Codex)" header extraction, and why there is no
      // caller-extensible argv). This process's own config keys
      // (binary/timeoutMs/model/profile/clonePath/worktreeRoot) map
      // one-to-one onto CodexReviewerConfig; unset ones keep the package's
      // own defaults.
      return createCodexReviewer(codexReviewerConfigFromEnv())
    case 'fake':
      // Smoke-test the loop end-to-end without shelling out to a real reviewer.
      return createFakeReviewer({ vendor: 'fake' })
    default:
      throw new Error(
        `Unknown GATE_REVIEWER "${kind}". Supported: codex, fake. ` +
        `Wire in another Reviewer implementation here once available.`,
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
