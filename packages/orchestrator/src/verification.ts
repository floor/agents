import type { CommandResult, GuardrailsConfig, ProjectCommand, VerificationResult } from '@floor-agents/core'
import { validateAgentOutput } from './guardrails.ts'
import { gitText, snapshotWorktree, type Worktree } from './worktree.ts'
import { projectCommandSandbox, sandboxed } from '@floor-agents/sandbox'

const OUTPUT_LIMIT = 32_768

async function readOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  let truncated = false
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const text = decoder.decode(value, { stream: true })
    if (output.length + text.length > OUTPUT_LIMIT) truncated = true
    output += text.slice(0, Math.max(0, OUTPUT_LIMIT - output.length))
  }
  return output + (truncated ? '\n[output truncated]' : '')
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
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++ ')) bytes += Buffer.byteLength(line) // the '+' stands for the newline
  }
  return bytes
}

/** Validate cumulative changes, including deletions, modes and agent commits. */
export async function validateWorktree(worktree: Worktree, baseSha: string, guardrails: GuardrailsConfig): Promise<void> {
  const tree = await snapshotWorktree(worktree)
  const paths = (await gitText(worktree.path, ['diff', '--name-only', '--no-renames', '-z', baseSha, tree])).split('\0').filter(Boolean)
  const files: { path: string; content: string }[] = []
  let total = 0
  for (const path of paths) {
    const entry = await gitText(worktree.path, ['ls-tree', tree, '--', path])
    const mode = entry.split(' ')[0]
    if (entry && mode !== '100644' && mode !== '100755') throw new Error(`Unsupported file mode for ${path}: ${mode}`)
    const object = entry.match(/^\d+ blob ([a-f0-9]+)\t/)
    const size = await changedBytes(worktree, baseSha, tree, path, object?.[1])
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

export async function verifyWorktree(worktree: Worktree, commands: readonly ProjectCommand[]): Promise<VerificationResult> {
  if (!commands.length) throw new Error('project.verification must define at least one check')
  const treeSha = await snapshotWorktree(worktree)
  const checks: CommandResult[] = []
  for (const command of commands) {
    console.log(`[verify] ${command.name}: ${command.command.join(' ')}`)
    const result = await runProjectCommand(worktree.path, command)
    checks.push(result)
    if (result.exitCode !== 0 || result.timedOut) break
  }
  const unchanged = treeSha === await snapshotWorktree(worktree)
  return {
    passed: unchanged && checks.length === commands.length && checks.every(c => c.exitCode === 0 && !c.timedOut),
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
