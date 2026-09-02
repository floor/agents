// Loads the review-and-gate loop's own YAML config (separate from the
// task-pipeline CompanyConfig — the gate mode has no agents/workflow/chain,
// just repos to watch and how to gate them). See config/gate/gate.example.yaml.

import { parse } from 'yaml'
import { DEFAULT_GATE_CONFIG, type GateConfig } from './decision.ts'
import { DEFAULT_VENDOR_CONFIG, type VendorAttributionConfig } from './vendor.ts'

export type GateModeConfig = {
  /** Bare repo names (no owner prefix) — the gate mode's GitAdapter is
   *  bound to a single owner (e.g. GITHUB_OWNER), matching the convention
   *  used throughout this codebase (see src/main.ts, CompanyConfig.project.repo). */
  readonly repos: readonly string[]
  readonly pollIntervalMs: number
  readonly promptTemplatePath: string
  readonly stateDir: string
  readonly mergeEnabled: boolean
  /** GitHub logins (case-insensitive) whose PRs this loop never processes
   *  — put this process's own posting identity here so it never reviews
   *  or merges its own PRs. Empty by default: configure it explicitly. */
  readonly excludeAuthors: readonly string[]
  readonly gate: GateConfig
  readonly vendor: VendorAttributionConfig
}

const DEFAULT_POLL_INTERVAL_MS = 60_000

function parseVendorConfig(raw: any): VendorAttributionConfig {
  if (!raw) return DEFAULT_VENDOR_CONFIG
  return {
    labelPrefix: raw.labelPrefix ?? DEFAULT_VENDOR_CONFIG.labelPrefix,
    branchPrefixes: (raw.branchPrefixes ?? DEFAULT_VENDOR_CONFIG.branchPrefixes).map((r: any) => ({
      prefix: r.prefix,
      vendor: r.vendor,
    })),
    bodyMarkers: (raw.bodyMarkers ?? DEFAULT_VENDOR_CONFIG.bodyMarkers).map((r: any) => ({
      prefix: r.prefix,
      vendor: r.vendor,
    })),
  }
}

function parseTrustedReviewers(raw: any): Record<string, string> {
  const trusted: Record<string, string> = {}
  for (const [login, vendor] of Object.entries(raw ?? {})) {
    trusted[String(login).toLowerCase()] = String(vendor)
  }
  return trusted
}

function parseGateConfig(raw: any): GateConfig {
  if (!raw) return DEFAULT_GATE_CONFIG
  return {
    authLabels: raw.authLabels ?? DEFAULT_GATE_CONFIG.authLabels,
    needsHumanLabel: raw.needsHumanLabel ?? DEFAULT_GATE_CONFIG.needsHumanLabel,
    trustedReviewers: raw.trustedReviewers ? parseTrustedReviewers(raw.trustedReviewers) : DEFAULT_GATE_CONFIG.trustedReviewers,
  }
}

/** `env` defaults to `process.env`; passed explicitly in tests so this
 *  stays free of hidden global state. */
export async function loadGateConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Promise<GateModeConfig> {
  const file = Bun.file(path)
  if (!await file.exists()) {
    throw new Error(`Gate config file not found: ${path}`)
  }

  const raw = parse(await file.text()) ?? {}

  const mergeEnabledRaw = env.GATE_MERGE_ENABLED ?? String(raw.mergeEnabled ?? 'false')
  const mergeEnabled = mergeEnabledRaw.toLowerCase() === 'true' || mergeEnabledRaw === '1'

  return {
    repos: raw.repos ?? [],
    pollIntervalMs: raw.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    promptTemplatePath: raw.promptTemplatePath ?? 'config/gate/review-prompt.md',
    stateDir: raw.stateDir ?? './data/gate',
    mergeEnabled,
    excludeAuthors: raw.excludeAuthors ?? [],
    gate: parseGateConfig(raw.gate),
    vendor: parseVendorConfig(raw.vendor),
  }
}
