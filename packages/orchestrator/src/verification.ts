import type { CommandResult, GuardrailsConfig, ProjectCommand, VerificationResult } from '@floor-agents/core'
import { createExcerptBuffer } from '@floor-agents/core'
import { validateAgentOutput } from './guardrails.ts'
import { gitText, snapshotWorktree, type Worktree } from './worktree.ts'
import { mkdtemp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { projectCommandSandbox, sandboxed } from '@floor-agents/sandbox'
import { trackChild } from './lifecycle.ts'

/**
 * What is kept of each stream: 32 KB, most of it from the end. A test run names
 * its failures and prints its summary last; the first 32 KB of a long suite are
 * passing tests, and keeping those left a failed gate with no reason in its record.
 */
const OUTPUT_HEAD = 4_096
const OUTPUT_TAIL = 28_672

async function readOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const kept = createExcerptBuffer(OUTPUT_HEAD, OUTPUT_TAIL)
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    kept.push(decoder.decode(value, { stream: true }))
  }
  return kept.text()
}

export async function runProjectCommand(cwd: string, check: ProjectCommand): Promise<CommandResult> {
  const start = performance.now()
  let timedOut = false
  try {
    // Setup and checks execute code the agent may have written — its tests, a
    // postinstall script — so they are contained like the agent: writes only to
    // the checkout and package caches. Refused where the sandbox is unavailable.
    const argv = sandboxed([...check.command], projectCommandSandbox([cwd]))
    const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', detached: process.platform !== 'win32' })
    trackChild(proc, proc.exited)
    const timeout = setTimeout(() => {
      timedOut = true
      // Test runners commonly spawn children which keep output pipes open.
      try {
        if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL')
        else proc.kill('SIGKILL')
      } catch { proc.kill('SIGKILL') }
    }, check.timeoutMs ?? 300_000)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([readOutput(proc.stdout), readOutput(proc.stderr), proc.exited])
      return { ...check, stdout, stderr, exitCode, timedOut, durationMs: Math.round(performance.now() - start) }
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    return { ...check, stdout: '', stderr: String(err), exitCode: -1, timedOut, durationMs: Math.round(performance.now() - start) }
  }
}

/**
 * How much the change wrote into `path`, in bytes: the lines it added.
 *
 * The size caps came from the API path, where an agent *outputs* whole files. A
 * native agent edits in place: a one-line entry in a 104 KB changelog is not a
 * 104 KB output, and summing whole files stopped finished work (vlist FLO-163,
 * FLO-185). Only added lines count — a patch also carries what was removed and
 * three lines of context around each hunk, so measuring the whole patch refused
 * the deletion of a large file and counted a rewrite twice (both measured the
 * day the patch measure shipped). A new file is all additions, so a generated
 * blob is still refused; a binary has no textual patch and counts as its blob.
 */
async function changedBytes(worktree: Worktree, baseSha: string, tree: string, path: string, blob: string | undefined): Promise<number> {
  if (!blob) return 0 // deleted: nothing was written
  const numstat = await gitText(worktree.path, ['diff', '--numstat', '--no-renames', baseSha, tree, '--', path])
  if (numstat.startsWith('-\t-\t')) return Number(await gitText(worktree.path, ['cat-file', '-s', blob]))
  const patch = await gitText(worktree.path, ['diff', '--no-renames', '--no-color', '--unified=0', baseSha, tree, '--', path])
  let bytes = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    // Only lines inside a hunk are content: the `+++ b/path` header is not, and
    // an added line that itself begins with `++ ` must not be mistaken for it.
    if (line.startsWith('@@')) inHunk = true
    else if (inHunk && line.startsWith('+')) bytes += Buffer.byteLength(line) // the '+' stands for the newline
  }
  return bytes
}

/** Paths that are an existing file moved without a change: nothing was written, whatever its size. */
async function movedUnchanged(worktree: Worktree, baseSha: string, tree: string): Promise<Set<string>> {
  const status = await gitText(worktree.path, ['diff', '--name-status', '-M100%', '-z', baseSha, tree])
  const fields = status.split('\0').filter(Boolean)
  const moved = new Set<string>()
  for (let i = 0; i < fields.length; i++) {
    if (fields[i]!.startsWith('R')) { moved.add(fields[i + 2]!); i += 2 } else i += 1
  }
  return moved
}

/** Validate cumulative changes, including deletions, modes and agent commits. */
export async function validateWorktree(worktree: Worktree, baseSha: string, guardrails: GuardrailsConfig): Promise<void> {
  const tree = await snapshotWorktree(worktree)
  const paths = (await gitText(worktree.path, ['diff', '--name-only', '--no-renames', '-z', baseSha, tree])).split('\0').filter(Boolean)
  const files: { path: string; content: string }[] = []
  const moved = await movedUnchanged(worktree, baseSha, tree)
  let total = 0
  for (const path of paths) {
    const entry = await gitText(worktree.path, ['ls-tree', tree, '--', path])
    const mode = entry.split(' ')[0]
    if (entry && mode !== '100644' && mode !== '100755') throw new Error(`Unsupported file mode for ${path}: ${mode}`)
    const object = entry.match(/^\d+ blob ([a-f0-9]+)\t/)
    const size = moved.has(path) ? 0 : await changedBytes(worktree, baseSha, tree, path, object?.[1])
    if (size > guardrails.maxFileSizeBytes) {
      throw new Error(`Guardrail: the change adds ${size} bytes to ${path}, over maxFileSizeBytes (${guardrails.maxFileSizeBytes})`)
    }
    total += size
    files.push({ path, content: '' })
  }
  if (total > guardrails.maxTotalOutputBytes) {
    throw new Error(`Guardrail: the change adds ${total} bytes across ${paths.length} files, over maxTotalOutputBytes (${guardrails.maxTotalOutputBytes})`)
  }
  const violations = validateAgentOutput({ files, rawResponse: '', prDescription: '', parseErrors: [] }, guardrails)
  if (violations.length) throw new Error(`Guardrails failed:\n${violations.map(v => v.detail).join('\n')}`)
}

/**
 * A clean checkout of exactly `treeSha`, beside the agent's worktree.
 *
 * The gate used to run in the agent's own worktree, where everything the turn
 * left behind is still lying around — ignored files, caches, a generated
 * artefact. Measured: a check that passed only because of an ignored
 * `cache/answer.json` was reported green, and the commit it "verified" did not
 * contain that file. What is published is a tree, so the tree is what is
 * checked: nothing the commit will not carry can help it pass.
 */
async function exportTree(worktree: Worktree, treeSha: string): Promise<{ readonly path: string; remove(): Promise<void> }> {
  const commit = await gitText(worktree.path, ['commit-tree', treeSha, '-p', worktree.initialSha, '-m', 'gate: the tree under verification'])
  const path = await mkdtemp(join(dirname(worktree.path), 'gate-'))
  await gitText(worktree.path, ['worktree', 'add', '--detach', path, commit])
  return {
    path,
    async remove() {
      try {
        await gitText(worktree.path, ['worktree', 'remove', '--force', path])
      } catch (err) {
        console.error(`[verify] failed to remove the gate export ${path}:`, err)
      }
    },
  }
}

/**
 * Run the gate on a clean export of the worktree's current tree.
 *
 * `setup` runs in the export first — it has no `node_modules` of its own — and a
 * setup that fails is a gate that fails, reported like any check. The export is
 * removed whatever happens; what a failing check printed is in the result.
 */
export async function verifyWorktree(
  worktree: Worktree, commands: readonly ProjectCommand[], setup: readonly ProjectCommand[] = [],
): Promise<VerificationResult> {
  if (!commands.length) throw new Error('project.verification must define at least one check')
  const treeSha = await snapshotWorktree(worktree)
  const gate = await exportTree(worktree, treeSha)
  const checks: CommandResult[] = []
  let setupFailed = false
  let unchanged = true
  try {
    for (const command of setup) {
      console.log(`[verify] setup — ${command.name}`)
      const result = await runProjectCommand(gate.path, command)
      if (result.exitCode !== 0 || result.timedOut) {
        checks.push({ ...result, name: `Setup: ${command.name}` })
        setupFailed = true
        break
      }
    }
    if (!setupFailed) {
      for (const command of commands) {
        console.log(`[verify] ${command.name}: ${command.command.join(' ')}`)
        const result = await runProjectCommand(gate.path, command)
        checks.push(result)
        if (result.exitCode !== 0 || result.timedOut) break
      }
    }
    // A check that rewrites tracked files verified something other than the tree it was given.
    await gitText(gate.path, ['add', '-A'])
    unchanged = treeSha === await gitText(gate.path, ['write-tree'])
  } finally {
    await gate.remove()
  }
  return {
    passed: unchanged && !setupFailed && checks.length === commands.length && checks.every(c => c.exitCode === 0 && !c.timedOut),
    treeSha,
    checkedAt: new Date().toISOString(),
    checks,
    ...(!unchanged ? { error: 'Checks modified the workspace; verification must run again on the final content' } : {}),
  }
}

export function verificationSummary(result: VerificationResult): string {
  return [
    `**Engine verification: ${result.passed ? 'PASSED' : 'FAILED'}**`,
    `Tree: \`${result.treeSha}\`${result.commitSha ? ` | Commit: \`${result.commitSha}\`` : ''}`,
    ...result.checks.map(c => `- ${c.name}: exit ${c.exitCode}${c.timedOut ? ' (timed out)' : ''} (${c.durationMs}ms)`),
    result.error ?? '',
  ].filter(Boolean).join('\n')
}
