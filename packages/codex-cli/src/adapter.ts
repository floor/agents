import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexProcessError, CodexTimeoutError } from './errors'
import { extractReview } from './extract'
import type { Reviewer, ReviewInput, ReviewResult } from './types'
import { resolveWorktree } from './worktree'

export type CodexReviewerConfig = {
  /** Path to the codex binary, or a fixture script in tests. Defaults to `'codex'`. */
  readonly binary?: string
  /** Kill the process and throw `CodexTimeoutError` after this many ms. Default 15 min. */
  readonly timeoutMs?: number
  /** `--sandbox` value. Default `'read-only'` — this reviewer never writes to the worktree. */
  readonly sandbox?: string
  /**
   * Extra argv entries inserted between the sandbox flag and the prompt. Must not
   * override the sandbox or approval policy — no `--sandbox`/`-s`, `--add-dir`, a
   * bypass flag (`--yolo`, `--approve-for-me`, `--not-so-yolo`, `--full-auto`,
   * `--dangerously-bypass-approvals-and-sandbox`), or a `-c`/`--config` setting
   * `sandbox_mode`/`approval_policy` (the constructor throws if any are present,
   * case-insensitively). Use `sandbox` instead if you need to change it. Copied and
   * frozen at construction time, so mutating an array passed here afterward has no
   * effect on an already-created reviewer.
   */
  readonly extraArgs?: readonly string[]
  /**
   * Local clone of the repo to review, used to create a detached worktree at
   * `headSha` when `review()` is called without a `worktreePath`. Required in that case.
   */
  readonly clonePath?: string
  /** Directory under which detached worktrees are created. Defaults to the OS temp dir. */
  readonly worktreeRoot?: string
}

const DEFAULT_BINARY = 'codex'
const DEFAULT_TIMEOUT_MS = 15 * 60_000 // 15 minutes
const DEFAULT_SANDBOX = 'read-only'

// Flags/config keys that select or bypass the sandbox or approval policy. The adapter
// sets the sandbox itself and no caller has a legitimate reason to pass any of these
// via extraArgs, so matching is deliberately broad (a prefix match on `-s`/`--sandbox`
// covers the bare flag, `-s <mode>`, the compact `-s<mode>`, and `-s=<mode>`/
// `--sandbox=<mode>` forms) rather than trying to enumerate every accepted spelling.
// All checks are case-insensitive.
const SANDBOX_BYPASS_FLAGS = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--approve-for-me',
  '--not-so-yolo',
  '--full-auto',
])
const DANGEROUS_CONFIG_KEYS = ['sandbox_mode', 'approval_policy']

function isDangerousConfigValue(value: string): boolean {
  return DANGEROUS_CONFIG_KEYS.some((key) => new RegExp(`^${key}\\s*=`, 'i').test(value))
}

export function containsSandboxOverride(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const lower = arg.toLowerCase()

    if (/^-s/i.test(arg)) return true // -s, -s <mode>, -s<mode> (compact), -s=<mode>
    if (/^--sandbox/i.test(arg)) return true // --sandbox, --sandbox=<mode>
    if (SANDBOX_BYPASS_FLAGS.has(lower)) return true
    if (/^--add-dir(=|$)/i.test(arg)) return true

    // -c/--config setting sandbox_mode or approval_policy: as a separate value argv
    // entry ("-c sandbox_mode=..."), compact ("-csandbox_mode=..."), or inline
    // ("--config=sandbox_mode=...").
    if (lower === '-c' || lower === '--config') {
      const value = args[i + 1]
      if (value !== undefined && isDangerousConfigValue(value)) return true
    } else if (/^-c/i.test(arg)) {
      if (isDangerousConfigValue(arg.slice(2))) return true
    } else if (/^--config=/i.test(arg)) {
      if (isDangerousConfigValue(arg.slice('--config='.length))) return true
    }
  }
  return false
}

/**
 * Copies `extraArgs` into a new, frozen array. Copying (rather than storing the
 * caller's array by reference) means a caller mutating their own array after
 * construction can never retroactively smuggle a sandbox override past the check in
 * `createCodexReviewer` or into the spawned argv; freezing means this package's own
 * code can't accidentally mutate it either.
 */
export function freezeExtraArgs(extraArgs?: readonly string[]): readonly string[] {
  return Object.freeze([...(extraArgs ?? [])])
}

/**
 * Creates a `Reviewer` that runs the Codex CLI in read-only mode against a PR's head
 * commit and returns its review text.
 *
 * Invocation (learned the hard way running this in the Radiooooo v4 program):
 *
 *   cd <worktree> && codex exec --sandbox read-only "<prompt>" > out 2>/dev/null < /dev/null
 *
 * - stdin is always closed: with stdin open, `codex exec` prints "Reading additional
 *   input from stdin..." and never returns.
 * - It must run inside a git worktree checked out at the PR head so `git diff` resolves.
 * - The read-only sandbox cannot run tests, so its conclusions are analytical only.
 * - It bills a ChatGPT subscription (`~/.codex/auth.json`), not an API key — nothing in
 *   this adapter reads or sets an API key env var.
 */
export function createCodexReviewer(config: CodexReviewerConfig = {}): Reviewer {
  const binary = config.binary ?? DEFAULT_BINARY
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sandbox = config.sandbox ?? DEFAULT_SANDBOX
  const extraArgs = freezeExtraArgs(config.extraArgs)

  if (containsSandboxOverride(extraArgs)) {
    throw new Error(
      'CodexReviewer: extraArgs must not override the sandbox or approval policy — no --sandbox/-s, --add-dir, a bypass flag (e.g. --yolo, --full-auto, --dangerously-bypass-approvals-and-sandbox), or a -c/--config setting sandbox_mode/approval_policy. Set `sandbox` in CodexReviewerConfig instead, so a later flag can never silently override the read-only guarantee.',
    )
  }

  return {
    vendor: 'codex',

    async review(input: ReviewInput): Promise<ReviewResult> {
      const worktree = await resolveWorktree({
        worktreePath: input.worktreePath,
        headSha: input.headSha,
        clonePath: config.clonePath,
        worktreeRoot: config.worktreeRoot,
      })

      try {
        const rawOutput = await runCodex({
          binary,
          sandbox,
          extraArgs,
          timeoutMs,
          prompt: input.prompt,
          cwd: worktree.cwd,
        })

        return { text: extractReview(rawOutput) }
      } finally {
        // Always tear down a worktree we created, on success, on a thrown
        // CodexProcessError/CodexTimeoutError/MalformedReviewError, and on any other
        // failure — never leak a worktree.
        await worktree.cleanup()
      }
    },
  }
}

async function runCodex(opts: {
  readonly binary: string
  readonly sandbox: string
  readonly extraArgs: readonly string[]
  readonly timeoutMs: number
  readonly prompt: string
  readonly cwd: string
}): Promise<string> {
  // The prompt is passed as a single argv element via Bun.spawn's array form (no
  // shell involved), so quotes, `$(...)`, backticks etc. inside the prompt are inert.
  const args = [opts.binary, 'exec', '--sandbox', opts.sandbox, ...opts.extraArgs, opts.prompt]

  const stdoutPath = join(tmpdir(), `codex-review-stdout-${randomUUID()}.log`)
  const stdoutFile = Bun.file(stdoutPath)

  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    // Bun.spawn defaults to a snapshot of process.env taken when the Bun process
    // launched, NOT the live process.env — pass it explicitly so env vars set at
    // runtime (auth, config) are actually inherited by the child.
    env: process.env,
    // Mandatory: with stdin open, `codex exec` waits on
    // "Reading additional input from stdin..." forever.
    stdin: 'ignore',
    // Captured to a file rather than buffered in memory, then read back below.
    stdout: stdoutFile,
    stderr: 'pipe',
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // SIGKILL, not the default SIGTERM: codex (or a wedged descendant) may ignore a
    // termination request, and a caught-but-ignored SIGTERM would leave `proc.exited`
    // unresolved forever, so this timeout would never actually bound the wait below.
    // SIGKILL cannot be caught or ignored.
    proc.kill('SIGKILL')
  }, opts.timeoutMs)

  try {
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])

    clearTimeout(timer)

    if (timedOut) {
      throw new CodexTimeoutError(`codex exec timed out after ${opts.timeoutMs}ms`, opts.timeoutMs)
    }

    if (exitCode !== 0) {
      throw new CodexProcessError(`codex exec exited with code ${exitCode}`, exitCode, stderr)
    }

    return await stdoutFile.text()
  } finally {
    clearTimeout(timer)
    await unlink(stdoutPath).catch(() => {})
  }
}
