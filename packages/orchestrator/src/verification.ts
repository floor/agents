import type { CommandResult, ExecutionState, GuardrailsConfig, ProjectCommand, VerificationResult } from '@floor-agents/core'
import { validateAgentOutput } from './guardrails.ts'
import { gitText, snapshotWorktree, type Worktree } from './worktree.ts'
import { projectCommandSandbox, sandboxed } from '@floor-agents/sandbox'

const OUTPUT_LIMIT = 32_768
const TAIL_LINES = 80

export class VerificationFailed extends Error {
  constructor(readonly verification: VerificationResult, readonly saved: ExecutionState) {
    const failure = acceptedChecks(verification).find(failedCheck)
    super(verification.error ?? `Verification failed: ${failure?.name} (exit ${failure?.exitCode}). Logs are in the execution state.`)
    this.name = 'VerificationFailed'
  }
}

type CapturedOutput = {
  readonly text: string
  readonly tail: string
  readonly truncated: boolean
}

function rollTail(tail: string, chunk: string): string {
  if (chunk.length >= OUTPUT_LIMIT) return chunk.slice(-OUTPUT_LIMIT)
  const combined = tail + chunk
  return combined.length > OUTPUT_LIMIT ? combined.slice(-OUTPUT_LIMIT) : combined
}

async function readOutput(stream: ReadableStream<Uint8Array>): Promise<CapturedOutput> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let head = ''
  let tail = ''
  let truncated = false
  const consume = (chunk: string): void => {
    if (!chunk) return
    tail = rollTail(tail, chunk)
    if (truncated) return
    if (head.length + chunk.length <= OUTPUT_LIMIT) {
      head += chunk
      return
    }
    head += chunk.slice(0, OUTPUT_LIMIT - head.length)
    truncated = true
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    consume(decoder.decode(value, { stream: true }))
  }
  consume(decoder.decode())
  if (!truncated) tail = head
  const text = truncated ? `${head}\n[output truncated]\n${tail}` : head
  return { text, tail, truncated }
}

function failedCheck(result: CommandResult): boolean {
  return result.exitCode !== 0 || result.timedOut
}

export function acceptedChecks(result: Pick<VerificationResult, 'checks'>): readonly CommandResult[] {
  return result.checks.filter(c => c.accepted !== false)
}

export function latestFailingCheck(result: Pick<VerificationResult, 'checks'>): CommandResult | undefined {
  const accepted = acceptedChecks(result)
  return [...accepted].reverse().find(failedCheck) ?? [...result.checks].reverse().find(failedCheck)
}

/** A command exit or timeout, not a mutation, spawn failure, guardrail, or missing failing step. */
export function isRepairableVerification(verification: VerificationResult | undefined): boolean {
  if (!verification || verification.passed || verification.error) return false
  const accepted = acceptedChecks(verification)
  if (accepted.some(c => c.failedToStart)) return false
  return accepted.some(failedCheck)
}

export function isRepairableGateFailure(err: unknown): err is VerificationFailed {
  return err instanceof VerificationFailed && isRepairableVerification(err.verification)
}

export function lastLines(text: string, n: number = TAIL_LINES): string {
  if (!text) return ''
  const lines = text.split('\n')
  return lines.length <= n ? text : lines.slice(-n).join('\n')
}

export function gateFailureSection(check: CommandResult, diffStat: string): readonly string[] {
  const truncated = Boolean(check.truncated) || check.stdout.includes('[output truncated]') || check.stderr.includes('[output truncated]')
  const stdout = lastLines(check.stdoutTail ?? check.stdout)
  const stderr = lastLines(check.stderrTail ?? check.stderr)
  return [
    '## Gate failure',
    `Step: ${check.name}`,
    `Exit code: ${check.exitCode}${check.timedOut ? ' (timed out)' : ''}`,
    ...(truncated ? ['Output was truncated; the tail of each stream is below.'] : []),
    '',
    '### stdout (last 80 lines)',
    '```',
    stdout || '(empty)',
    '```',
    '',
    '### stderr (last 80 lines)',
    '```',
    stderr || '(empty)',
    '```',
    '',
    '### Diff since base',
    '```',
    diffStat.trimEnd() || '(no diff)',
    '```',
  ]
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
      return {
        name: check.name,
        command: check.command,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTail: stdout.tail,
        stderrTail: stderr.tail,
        truncated: stdout.truncated || stderr.truncated,
        exitCode,
        timedOut,
        durationMs: Math.round(performance.now() - start),
        ...(check.flaky ? { flaky: true } : {}),
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    return {
      name: check.name,
      command: check.command,
      stdout: '',
      stderr: String(err),
      stdoutTail: '',
      stderrTail: String(err),
      truncated: false,
      exitCode: -1,
      timedOut,
      failedToStart: true,
      durationMs: Math.round(performance.now() - start),
      ...(check.flaky ? { flaky: true } : {}),
    }
  }
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
    const size = object ? Number(await gitText(worktree.path, ['cat-file', '-s', object[1]!])) : 0
    if (size > guardrails.maxFileSizeBytes) throw new Error(`Guardrail: ${path} exceeds maxFileSizeBytes`)
    total += size
    files.push({ path, content: '' })
  }
  if (total > guardrails.maxTotalOutputBytes) throw new Error('Guardrail: changes exceed maxTotalOutputBytes')
  const violations = validateAgentOutput({ files, rawResponse: '', prDescription: '', parseErrors: [] }, guardrails)
  if (violations.length) throw new Error(`Guardrails failed:\n${violations.map(v => v.detail).join('\n')}`)
}

export async function verifyWorktree(worktree: Worktree, commands: readonly ProjectCommand[]): Promise<VerificationResult> {
  if (!commands.length) throw new Error('project.verification must define at least one check')
  const start = performance.now()
  const treeSha = await snapshotWorktree(worktree)
  const checks: CommandResult[] = []

  const mutated = async () => treeSha !== await snapshotWorktree(worktree)

  for (const command of commands) {
    console.log(`[verify] ${command.name}: ${command.command.join(' ')}`)
    const result = await runProjectCommand(worktree.path, command)
    if (result.failedToStart) {
      checks.push({ ...result, accepted: true })
      return {
        passed: false,
        treeSha,
        checkedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - start),
        checks,
        error: `Failed to start ${command.name}: ${result.stderr}`,
      }
    }
    const dirty = await mutated()
    if (command.flaky && failedCheck(result) && !dirty) {
      checks.push({ ...result, accepted: false })
      console.log(`[verify] ${command.name}: flaky retry`)
      const retry = await runProjectCommand(worktree.path, command)
      if (retry.failedToStart) {
        checks.push({ ...retry, accepted: true })
        return {
          passed: false,
          treeSha,
          checkedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - start),
          checks,
          error: `Failed to start ${command.name}: ${retry.stderr}`,
        }
      }
      checks.push({ ...retry, accepted: true })
      if (failedCheck(retry) || await mutated()) break
      continue
    }
    checks.push({ ...result, accepted: true })
    if (failedCheck(result) || dirty) break
  }

  const unchanged = !await mutated()
  const accepted = acceptedChecks({ checks })
  return {
    passed: unchanged && accepted.length === commands.length && accepted.every(c => !failedCheck(c)),
    treeSha,
    checkedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
    checks,
    ...(!unchanged ? { error: 'Checks modified the workspace; verification must run again on the final content' } : {}),
  }
}

export function verificationSummary(result: VerificationResult): string {
  return [
    `**Engine verification: ${result.passed ? 'PASSED' : 'FAILED'}**`,
    `Tree: \`${result.treeSha}\`${result.commitSha ? ` | Commit: \`${result.commitSha}\`` : ''}`,
    ...result.checks.map(c => `- ${c.name}: exit ${c.exitCode}${c.timedOut ? ' (timed out)' : ''}${c.accepted === false ? ' (flaky, discarded)' : ''} (${c.durationMs}ms)`),
    result.error ?? '',
  ].filter(Boolean).join('\n')
}
