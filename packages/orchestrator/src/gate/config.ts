// Loads the review-and-gate loop's own YAML config (separate from the
// task-pipeline CompanyConfig — the gate mode has no agents/workflow/chain,
// just repos to watch and how to gate them). See config/gate/gate.example.yaml.

import { parse } from 'yaml'
import { DEFAULT_GATE_CONFIG, type GateConfig } from './decision.ts'
import { DEFAULT_VENDOR_CONFIG, type VendorAttributionConfig } from './vendor.ts'
import { DEFAULT_CHECKLISTS_CONFIG, type ChecklistsConfig } from './checklists.ts'

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
  /** Rules selecting which checklist file(s) — read from the TARGET
   *  repo's own checked-out head, not from this repo — go into the
   *  `{{checklists}}` prompt placeholder. Defaults to no rules, in which
   *  case every reviewer prompt renders the "no checklist matched" line
   *  in that slot, same as before this config key existed. */
  readonly checklists: ChecklistsConfig
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

/** A trustedReviewers value is either a single vendor name, or an array of
 *  vendor names for a login that's trusted to post reviews for more than
 *  one vendor (see GateConfig.trustedReviewers's doc comment in decision.ts
 *  for why: e.g. the gate loop's own bot account posting both a primary and
 *  a `secondReviewer` review under one GitHub identity).
 *
 *  `Object.create(null)`, not `{}` — a login key literally named
 *  `"__proto__"` in the YAML config assigns a plain object's PROTOTYPE
 *  rather than an own property (an array value would then be inherited by
 *  every other lookup on this object, e.g. resolving login `"0"` to that
 *  array's index-0 entry via prototype-chain lookup, without ever being
 *  configured for it). A null-prototype object has no `__proto__` accessor
 *  to trigger, so that key becomes an ordinary (and harmless, since no
 *  comment author's login is ever literally `__proto__`) own property. */
function parseTrustedReviewers(raw: any): Record<string, string | readonly string[]> {
  const trusted: Record<string, string | readonly string[]> = Object.create(null)
  for (const [login, value] of Object.entries(raw ?? {})) {
    const key = String(login).toLowerCase()
    trusted[key] = Array.isArray(value) ? value.map(v => String(v)) : String(value)
  }
  return trusted
}

function parseChecklistsConfig(raw: any): ChecklistsConfig {
  if (!raw || !Array.isArray(raw.rules)) return DEFAULT_CHECKLISTS_CONFIG
  return {
    rules: raw.rules.map((r: any) => ({
      label: r.label !== undefined ? String(r.label) : undefined,
      pathContains: r.pathContains !== undefined ? String(r.pathContains) : undefined,
      file: String(r.file),
    })),
  }
}

function parseGateConfig(raw: any): GateConfig {
  if (!raw) return DEFAULT_GATE_CONFIG
  return {
    authLabels: raw.authLabels ?? DEFAULT_GATE_CONFIG.authLabels,
    needsHumanLabel: raw.needsHumanLabel ?? DEFAULT_GATE_CONFIG.needsHumanLabel,
    trustedReviewers: raw.trustedReviewers ? parseTrustedReviewers(raw.trustedReviewers) : DEFAULT_GATE_CONFIG.trustedReviewers,
    secondReviewer: raw.secondReviewer !== undefined ? String(raw.secondReviewer) : undefined,
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
    checklists: parseChecklistsConfig(raw.checklists),
  }
}
