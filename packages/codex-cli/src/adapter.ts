import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexProcessError, CodexTimeoutError } from './errors'
import { extractReview } from './extract'
import type { Reviewer, ReviewInput, ReviewResult } from './types'
import { resolveWorktree } from './worktree'

// Four rounds of an adversarial review kept finding new ways to smuggle an argv
// element past a denylist on a caller-supplied extraArgs (a second --sandbox, a short
// alias, a compact form, a -c/--config key, --add-dir, --cd/-C...). The fix is not a
// bigger denylist: there is no caller-extensible argv at all. The only configurable
// inputs are two typed, validated values translated into fixed flags by this adapter
// itself; the sandbox mode, the subcommand, and the prompt's position are not
// configurable by a caller under any name.
export type CodexReviewerConfig = {
  /** Path to the codex binary, or a fixture script in tests. Defaults to `'codex'`. */
  readonly binary?: string
  /** Kill the process and throw `CodexTimeoutError` after this many ms. Default 15 min. */
  readonly timeoutMs?: number
  /**
   * Emitted as `--model <value>`. Must be an actual string primitive (the constructor
   * throws for an object, even one with a custom `toString`/`valueOf`), matching
   * `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, max 128 chars.
   */
  readonly model?: string
  /** Emitted as `--profile <value>`. Same validation as `model`. */
  readonly profile?: string
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
// Fixed, not configurable: this reviewer never writes to the worktree, under any name.
const SANDBOX = 'read-only'

// The leading-character restriction (must start alphanumeric) means a value can never
// itself start with `-`, so it can never be mistaken for a flag by codex's own argv
// parser — "--sandbox" and "-x" both fail this, not just something with a shell
// metacharacter in it.
const OPTION_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const OPTION_VALUE_MAX_LENGTH = 128

/**
 * Reads `raw` exactly once, checks it is an actual string primitive (not an object,
 * not something with a `toString`/`valueOf` that coerces to a string, not a getter
 * that could return something different on a second read), validates it, and returns
 * that same primitive. The caller must build argv only from this return value — never
 * by re-reading the original config property — so there is no window between
 * validating a value and using it where it could have changed or where a coercion
 * could sneak a disallowed value through.
 */
function readValidatedOption(name: 'model' | 'profile', raw: unknown): string | undefined {
  if (raw === undefined) return undefined

  const value = requireStringPrimitive(name, raw)

  if (value.length > OPTION_VALUE_MAX_LENGTH || !OPTION_VALUE_RE.test(value)) {
    throw new Error(
      `CodexReviewer: ${name} must match ${OPTION_VALUE_RE} and be at most ${OPTION_VALUE_MAX_LENGTH} characters — got ${JSON.stringify(value)}. This is deliberately restrictive: it is translated straight into an argv element, so it must not be able to look like a flag or carry shell/argv metacharacters.`,
    )
  }

  return value
}

/**
 * The same "read exactly once, reject anything that isn't an actual string
 * primitive" discipline as `readValidatedOption`, applied to path-shaped values
 * (`binary`, `clonePath`, `worktreeRoot`, `worktreePath`) instead of flag values: no
 * charset restriction (paths legitimately contain `/`, spaces, etc.), just a type
 * check and a non-empty check. Every later use of these values — the `git -C` calls,
 * `Bun.spawn`'s `cwd`, the caller-supplied-path removal guard — reads the snapshot
 * this returns, never the original config/input property, so a value can't change
 * (via a getter or a coercing object) between being checked and being used.
 */
function requireStringPrimitive(name: string, raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error(
      `CodexReviewer: ${name} must be a string — got ${typeof raw}. Objects (including ones with a custom toString/valueOf) are rejected outright, not coerced.`,
    )
  }
  return raw
}

function readOptionalPath(name: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  return readRequiredPath(name, raw)
}

function readRequiredPath(name: string, raw: unknown): string {
  const value = requireStringPrimitive(name, raw)
  if (value.length === 0) {
    throw new Error(`CodexReviewer: ${name} must be a non-empty string.`)
  }
  return value
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
 *
 * argv is fixed by design: `[binary, 'exec', '--sandbox', 'read-only', ...typed flags
 * from `model`/`profile`, prompt]`. There is no `extraArgs` and no way for a caller to
 * add, remove, or reorder an argv element — `model` and `profile` are validated
 * against a strict charset and can only ever render as their own `--model`/`--profile`
 * flag pair, never as something else.
 */
export function createCodexReviewer(config: CodexReviewerConfig = {}): Reviewer {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Every config value that ends up in a git/spawn call is read from `config` exactly
  // once, right here, into this single frozen snapshot. Every later use — argv,
  // `git -C`, `Bun.spawn`'s `cwd` — reads `resolvedOptions`, never `config` again, so
  // none of these can change (via a getter or a coercing object) between being
  // checked and being used.
  const resolvedOptions = Object.freeze({
    binary: readRequiredPath('binary', config.binary ?? DEFAULT_BINARY),
    clonePath: readOptionalPath('clonePath', config.clonePath),
    worktreeRoot: readOptionalPath('worktreeRoot', config.worktreeRoot),
    model: readValidatedOption('model', config.model),
    profile: readValidatedOption('profile', config.profile),
  })

  const typedFlags: string[] = []
  if (resolvedOptions.model !== undefined) typedFlags.push('--model', resolvedOptions.model)
  if (resolvedOptions.profile !== undefined) typedFlags.push('--profile', resolvedOptions.profile)
  Object.freeze(typedFlags)

  return {
    vendor: 'codex',

    async review(input: ReviewInput): Promise<ReviewResult> {
      // `input.worktreePath` is per-call caller input, so it can only be snapshotted
      // here, at the top of `review()`, rather than at construction — but the same
      // rule applies: read once, validate, and use only this local from here on.
      const worktreePath = readOptionalPath('worktreePath', input.worktreePath)

      const worktree = await resolveWorktree({
        worktreePath,
        headSha: input.headSha,
        clonePath: resolvedOptions.clonePath,
        worktreeRoot: resolvedOptions.worktreeRoot,
      })

      try {
        const rawOutput = await runCodex({
          binary: resolvedOptions.binary,
          typedFlags,
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
  readonly typedFlags: readonly string[]
  readonly timeoutMs: number
  readonly prompt: string
  readonly cwd: string
}): Promise<string> {
  // Fixed shape, no caller-extensible piece except the two typed, validated flags —
  // and the prompt is always the last argv element via Bun.spawn's array form (no
  // shell involved), so quotes, `$(...)`, backticks, or a leading `-` inside the
  // prompt are inert rather than being interpreted as another flag.
  const args = [opts.binary, 'exec', '--sandbox', SANDBOX, ...opts.typedFlags, opts.prompt]

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
