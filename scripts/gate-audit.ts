#!/usr/bin/env bun
// Reads the review-and-gate loop's persisted state directory
// (GateModeConfig.stateDir, one JSON file per PR — see
// packages/orchestrator/src/gate/state-store.ts) and prints a table: PR,
// head, decision, reason, timestamp. Used during a dry-run soak
// (docs/dry-run-soak.md) to compare the gate's "would merge"/hold/blocked
// decisions against what a human coordinator actually did with the same
// PRs, without having to read the raw JSON files or scroll back through
// process logs by hand.
//
// Usage:
//   bun run scripts/gate-audit.ts [stateDir]
//   GATE_STATE_DIR=./data/gate bun run scripts/gate-audit.ts
//
// stateDir defaults to './data/gate' (GateModeConfig's own default — see
// config/gate/gate.example.yaml). A positional argument, if given, wins
// over GATE_STATE_DIR.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { GatePrState } from '@floor-agents/orchestrator'

const DEFAULT_STATE_DIR = './data/gate'

function resolveStateDir(argv: readonly string[], env: Record<string, string | undefined>): string {
  return argv[2] ?? env.GATE_STATE_DIR ?? DEFAULT_STATE_DIR
}

/** Minimal structural check — enough to catch a file that clearly isn't a
 *  GatePrState (wrong shape, or the corrupt-JSON case createGateStateStore
 *  itself already logs and treats as "no state") without needing a full
 *  schema validator for a small internal audit script. */
function looksLikeGatePrState(value: unknown): value is GatePrState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.repo === 'string' &&
    typeof v.prNumber === 'string' &&
    typeof v.headSha === 'string' &&
    typeof v.decisionKind === 'string' &&
    typeof v.updatedAt === 'string'
  )
}

async function loadStates(stateDir: string): Promise<GatePrState[]> {
  let entries: string[]
  try {
    entries = await readdir(stateDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`gate-audit: state directory not found: ${stateDir}`)
      console.error('(nothing to audit yet — the gate loop creates this directory on its first pass)')
      return []
    }
    throw err
  }

  const states: GatePrState[] = []

  for (const entry of entries) {
    // The state store writes "<name>.tmp" before an atomic rename to
    // "<name>.json" (packages/orchestrator/src/gate/state-store.ts) — a
    // ".tmp" file here would only exist mid-write or after a crash, and
    // isn't a committed decision either way, so it's skipped rather than
    // treated as a read error.
    if (!entry.endsWith('.json')) continue

    const path = join(stateDir, entry)
    try {
      const raw = await Bun.file(path).json()
      if (!looksLikeGatePrState(raw)) {
        console.error(`gate-audit: skipping ${entry} — doesn't look like gate state`)
        continue
      }
      states.push(raw)
    } catch {
      console.error(`gate-audit: skipping ${entry} — corrupt JSON`)
    }
  }

  return states
}

function decisionLabel(state: GatePrState): string {
  return state.decisionKind === 'mergeable' && state.merged ? 'mergeable (merged)' : state.decisionKind
}

type Row = {
  pr: string
  head: string
  decision: string
  reason: string
  updated: string
}

function toRows(states: readonly GatePrState[]): Row[] {
  const rows = states.map((state): Row => ({
    pr: `${state.repo}#${state.prNumber}`,
    head: state.headSha.slice(0, 7),
    decision: decisionLabel(state),
    reason: state.reason ?? '-',
    updated: state.updatedAt,
  }))

  // Group by repo, then by PR number ascending (numeric, not lexical, so
  // #9 sorts before #10) — a stable, predictable order for scanning by eye
  // or diffing between two audit runs, rather than timestamp order (which
  // reshuffles every pass).
  return rows.sort((a, b) => {
    if (a.pr === b.pr) return 0
    const [repoA, prA] = splitPr(a.pr)
    const [repoB, prB] = splitPr(b.pr)
    if (repoA !== repoB) return repoA < repoB ? -1 : 1
    return prA - prB
  })
}

function splitPr(pr: string): readonly [string, number] {
  const i = pr.lastIndexOf('#')
  return [pr.slice(0, i), Number(pr.slice(i + 1))]
}

function printTable(rows: readonly Row[]): void {
  if (rows.length === 0) {
    console.log('gate-audit: no persisted gate state found — nothing to show yet.')
    return
  }

  const columns: { header: string; key: keyof Row }[] = [
    { header: 'PR', key: 'pr' },
    { header: 'HEAD', key: 'head' },
    { header: 'DECISION', key: 'decision' },
    { header: 'REASON', key: 'reason' },
    { header: 'UPDATED', key: 'updated' },
  ]

  const widths = columns.map(col => Math.max(col.header.length, ...rows.map(row => row[col.key].length)))

  const formatRow = (values: readonly string[]): string =>
    values.map((value, i) => value.padEnd(widths[i]!)).join('  ').trimEnd()

  console.log(formatRow(columns.map(col => col.header)))
  for (const row of rows) {
    console.log(formatRow(columns.map(col => row[col.key])))
  }
}

const stateDir = resolveStateDir(process.argv, process.env)
const states = await loadStates(stateDir)
printTable(toRows(states))
