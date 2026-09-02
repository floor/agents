// Determines which vendor implemented a PR, so the gate can enforce the
// protocol's "reviewer from a different vendor than the implementer" rule.
// Config-driven and pure — no I/O.

export type VendorRule = {
  readonly prefix: string
  readonly vendor: string
}

export type VendorAttributionConfig = {
  /** Label prefix that names the implementer vendor directly, e.g. a PR
   *  labeled "vendor:grok" attributes to "grok". Checked first. */
  readonly labelPrefix?: string
  /** Branch-name prefix rules, checked in order after the label. */
  readonly branchPrefixes: readonly VendorRule[]
  /** PR-body marker rules: a rule matches when some line of the body
   *  starts with `prefix` (e.g. a `Claude-Session:` commit trailer).
   *  Checked in order, after branch prefixes. */
  readonly bodyMarkers: readonly VendorRule[]
}

export const DEFAULT_VENDOR_CONFIG: VendorAttributionConfig = {
  labelPrefix: 'vendor:',
  branchPrefixes: [
    { prefix: 'cursor/', vendor: 'grok' },
  ],
  bodyMarkers: [
    { prefix: 'Claude-Session:', vendor: 'claude' },
  ],
}

export type VendorAttributionInput = {
  readonly headRef: string
  readonly body: string
  readonly labels: readonly string[]
}

/** Returns the implementer vendor for a PR: `vendor:<name>` label, then
 *  branch-prefix rules, then body-marker rules, else 'human'. */
export function attributeImplementerVendor(
  pr: VendorAttributionInput,
  config: VendorAttributionConfig = DEFAULT_VENDOR_CONFIG,
): string {
  const labelPrefix = config.labelPrefix ?? 'vendor:'
  const vendorLabel = pr.labels.find(l => l.startsWith(labelPrefix))
  if (vendorLabel) return vendorLabel.slice(labelPrefix.length)

  for (const rule of config.branchPrefixes) {
    if (pr.headRef.startsWith(rule.prefix)) return rule.vendor
  }

  const bodyLines = pr.body.split(/\r?\n/)
  for (const rule of config.bodyMarkers) {
    if (bodyLines.some(line => line.startsWith(rule.prefix))) return rule.vendor
  }

  return 'human'
}
