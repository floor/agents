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
  /** Extra argv entries inserted between the sandbox flag and the prompt. */
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
  const extraArgs = config.extraArgs ?? []

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
    proc.kill()
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
