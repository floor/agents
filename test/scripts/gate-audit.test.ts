// Runs scripts/gate-audit.ts as a real subprocess against a temp state
// directory populated with fixture GatePrState JSON files (the same shape
// packages/orchestrator/src/gate/state-store.ts writes), asserting on its
// actual stdout — not importing its internals — since the whole point of
// the script is its CLI output (see docs/dry-run-soak.md).

import { test, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'gate-audit.ts')

async function runAudit(args: readonly string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function writeState(dir: string, fileName: string, state: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, fileName), JSON.stringify(state))
}

test('prints an empty-state message and exits 0 when the state directory does not exist', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'gate-audit-test-'))
  try {
    const missingDir = join(parent, 'does-not-exist')
    const { stdout, stderr, exitCode } = await runAudit([missingDir])

    expect(exitCode).toBe(0)
    expect(stderr).toContain('state directory not found')
    expect(stdout).toContain('no persisted gate state found')
  } finally {
    await rm(parent, { recursive: true, force: true }).catch(() => {})
  }
})

test('prints a table sorted by repo then numeric PR number, not lexical or timestamp order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-audit-test-'))
  try {
    // Intentionally written out of order, and with PR "9"/"100" whose
    // lexical order would be wrong ("100" < "9" as strings).
    await writeState(dir, 'acme__widgets__100.json', {
      repo: 'acme/widgets', prNumber: '100', headSha: '1'.repeat(40),
      decisionKind: 'needs_review', reason: null, merged: false,
      reviewedHeads: {}, updatedAt: '2026-09-01T14:03:12.000Z',
    })
    await writeState(dir, 'acme__widgets__9.json', {
      repo: 'acme/widgets', prNumber: '9', headSha: '2'.repeat(40),
      decisionKind: 'blocked', reason: 'checks failing', merged: false,
      reviewedHeads: {}, updatedAt: '2026-09-01T14:03:12.000Z',
    })
    await writeState(dir, 'acme__widgets__42.json', {
      repo: 'acme/widgets', prNumber: '42', headSha: '3'.repeat(40),
      decisionKind: 'mergeable', reason: null, merged: false,
      reviewedHeads: {}, updatedAt: '2026-09-01T14:03:11.000Z',
    })

    const { stdout, exitCode } = await runAudit([dir])
    expect(exitCode).toBe(0)

    const lines = stdout.trim().split('\n')
    expect(lines[0]).toMatch(/^PR\s+HEAD\s+DECISION\s+REASON\s+UPDATED$/)

    const prColumn = lines.slice(1).map(line => line.split(/\s+/)[0])
    expect(prColumn).toEqual(['acme/widgets#9', 'acme/widgets#42', 'acme/widgets#100'])

    // Head sha is shortened to 7 chars, a null reason renders as "-".
    expect(stdout).toContain('1111111')
    expect(stdout).toContain('checks failing')
    expect(stdout).toMatch(/acme\/widgets#42\s+3333333\s+mergeable\s+-/)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('labels a merged mergeable PR distinctly from a still-dry-run mergeable one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-audit-test-'))
  try {
    await writeState(dir, 'acme__widgets__1.json', {
      repo: 'acme/widgets', prNumber: '1', headSha: '4'.repeat(40),
      decisionKind: 'mergeable', reason: null, merged: true,
      reviewedHeads: {}, updatedAt: '2026-09-01T14:03:11.000Z',
    })
    await writeState(dir, 'acme__widgets__2.json', {
      repo: 'acme/widgets', prNumber: '2', headSha: '5'.repeat(40),
      decisionKind: 'mergeable', reason: null, merged: false,
      reviewedHeads: {}, updatedAt: '2026-09-01T14:03:11.000Z',
    })

    const { stdout } = await runAudit([dir])
    expect(stdout).toContain('mergeable (merged)')
    expect(stdout).toMatch(/acme\/widgets#2\s+\S+\s+mergeable\s+-/)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('skips a corrupt JSON file and a .tmp file rather than crashing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-audit-test-'))
  try {
    await writeFile(join(dir, 'acme__widgets__bad.json'), 'not json at all')
    await writeFile(join(dir, 'acme__widgets__7.json.tmp'), JSON.stringify({
      repo: 'acme/widgets', prNumber: '7', headSha: '6'.repeat(40),
      decisionKind: 'needs_review', reason: null, merged: false,
      reviewedHeads: {}, updatedAt: '2026-09-01T14:03:11.000Z',
    }))
    await writeState(dir, 'acme__widgets__8.json', {
      repo: 'acme/widgets', prNumber: '8', headSha: '7'.repeat(40),
      decisionKind: 'needs_review', reason: null, merged: false,
      reviewedHeads: {}, updatedAt: '2026-09-01T14:03:11.000Z',
    })

    const { stdout, stderr, exitCode } = await runAudit([dir])
    expect(exitCode).toBe(0)
    expect(stderr).toContain('corrupt JSON')
    expect(stdout).toContain('acme/widgets#8')
    // The .tmp file's PR ("7") must not appear — it's a pre-rename artifact,
    // never a committed decision.
    expect(stdout).not.toContain('acme/widgets#7')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('GATE_STATE_DIR env var is used when no positional argument is given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-audit-test-'))
  try {
    await writeState(dir, 'acme__widgets__1.json', {
      repo: 'acme/widgets', prNumber: '1', headSha: '8'.repeat(40),
      decisionKind: 'hold', reason: 'checks pending', merged: false,
      reviewedHeads: {}, updatedAt: '2026-09-01T14:03:11.000Z',
    })

    const { stdout, exitCode } = await runAudit([], { GATE_STATE_DIR: dir })
    expect(exitCode).toBe(0)
    expect(stdout).toContain('acme/widgets#1')
    expect(stdout).toContain('checks pending')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('a positional argument wins over GATE_STATE_DIR', async () => {
  const envDir = await mkdtemp(join(tmpdir(), 'gate-audit-test-env-'))
  const argDir = await mkdtemp(join(tmpdir(), 'gate-audit-test-arg-'))
  try {
    await writeState(envDir, 'acme__widgets__1.json', {
      repo: 'acme/widgets', prNumber: '1', headSha: '9'.repeat(40),
      decisionKind: 'blocked', reason: 'from env dir', merged: false,
      reviewedHeads: {}, updatedAt: '2026-09-01T14:03:11.000Z',
    })
    await writeState(argDir, 'acme__widgets__2.json', {
      repo: 'acme/widgets', prNumber: '2', headSha: 'a'.repeat(40),
      decisionKind: 'blocked', reason: 'from arg dir', merged: false,
      reviewedHeads: {}, updatedAt: '2026-09-01T14:03:11.000Z',
    })

    const { stdout } = await runAudit([argDir], { GATE_STATE_DIR: envDir })
    expect(stdout).toContain('from arg dir')
    expect(stdout).not.toContain('from env dir')
  } finally {
    await rm(envDir, { recursive: true, force: true }).catch(() => {})
    await rm(argDir, { recursive: true, force: true }).catch(() => {})
  }
})
