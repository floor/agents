/**
 * How a cost is written where people read it.
 *
 * A CLI on a subscription reports no price, and the adapters record 0 for it.
 * Printing "$0.0000" on a pull request or an issue states something false —
 * the work was paid for, by the subscription — and puts spending on a public
 * page besides. So a zero cost is written as nothing at all, and only a metered
 * provider's real cost is shown.
 */

/** `$0.1234`, or empty when nothing was metered. */
export function costNote(cost: number): string {
  return Number.isFinite(cost) && cost > 0 ? `$${cost.toFixed(4)}` : ''
}

/** Join the parts of a `> a | b` line, dropping the empty ones. */
export function metaLine(parts: readonly string[]): string {
  return parts.filter(Boolean).join(' | ')
}
