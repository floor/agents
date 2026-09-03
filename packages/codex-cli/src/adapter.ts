import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexProcessError, CodexTimeoutError } from './errors'
import { extractReview } from './extract'
import type { PrepareStep, Reviewer, ReviewInput, ReviewResult } from './types'
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

// Fallback for a caller that sets `input.prepareSteps` but not
// `input.prepareTimeoutMs` (e.g. an older caller, or one that doesn't
// source it from gate/loop.ts's own GateModeConfig.prepare.timeoutMs).
// Same value as @floor-agents/orchestrator's own DEFAULT_PREPARE_TIMEOUT_MS
// — kept as an independent constant, not a cross-package import, since
// this package must not depend on @floor-agents/orchestrator (that
// package already depends on this one, via gate/create-reviewer.ts).
const DEFAULT_PREPARE_TIMEOUT_MS = 120_000

// Known lockfile filenames, checked in this order — the first one found in
// a prepare step's directory is hashed to build its cache key (floor/agents#32:
// "cached by lockfile hash"). A directory with none of these is simply not
// cacheable (nothing to key staleness off of), not an error.
const LOCKFILE_CANDIDATES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']

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
 * Returns a cache key combining `command` and the content hash of whichever
 * `LOCKFILE_CANDIDATES` entry is found first in `dir` (its own filename is
 * folded into the key too, so switching lockfile kinds in the same
 * directory is never mistaken for "unchanged") — or `null` if none exists,
 * meaning this step is NOT cacheable (nothing to key staleness off of, so
 * the caller must always run it fresh rather than guess).
 */
async function computePrepareCacheKey(dir: string, command: string): Promise<string | null> {
  for (const name of LOCKFILE_CANDIDATES) {
    const file = Bun.file(join(dir, name))
    if (await file.exists()) {
      const hasher = new Bun.CryptoHasher('sha256')
      hasher.update(await file.arrayBuffer())
      return `${command} ${name} ${hasher.digest('hex')}`
    }
  }
  return null
}

/**
 * Runs one prepare command via the OS shell, from `opts.cwd`, killing it
 * (SIGKILL, same reasoning as `runCodex`'s own timeout below — a hung
 * install may ignore SIGTERM) after `opts.timeoutMs`. Returns `true` iff it
 * exited zero before the timeout — NEVER throws, including when `opts.cwd`
 * doesn't exist or the shell itself can't be spawned: a prepare step is
 * best-effort by design (see `ReviewInput.prepareSteps`'s doc comment), so
 * every failure mode collapses to the same "false", for the caller to
 * report as one line rather than treat as fatal.
 *
 * stdout/stderr are deliberately never captured (`'ignore'`, not `'pipe'`)
 * — floor/agents#32's own "output excluded from the prompt" requirement is
 * met structurally this way: there is no code path for a prepare command's
 * own output (e.g. `bun install`'s full log) to reach anything that could
 * end up in the review prompt, rather than relying on remembering to
 * discard it later.
 */
async function runPrepareStep(opts: {
  readonly cwd: string
  readonly command: string
  readonly timeoutMs: number
}): Promise<boolean> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['/bin/sh', '-c', opts.command], {
      cwd: opts.cwd,
      env: process.env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
  } catch {
    return false
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, opts.timeoutMs)

  try {
    const exitCode = await proc.exited
    return !timedOut && exitCode === 0
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Runs every selected `steps` entry (skipping/reusing via `cache` when a
 * step's directory has a cacheable lockfile whose hash this `cache`
 * instance has already seen — see `computePrepareCacheKey`), and returns a
 * short, one-line-per-adapter-call summary of which steps failed or timed
 * out, empty when every step succeeded (or `steps` was empty). `cache` is
 * owned by the caller (one per `createCodexReviewer()` instance, so it
 * persists across `review()` calls for that Reviewer's whole lifetime —
 * "run once per base sha and reuse" in practice, since an unchanged
 * lockfile hashes the same across many reviews).
 */
async function runPrepareSteps(
  steps: readonly PrepareStep[],
  worktreeCwd: string,
  timeoutMs: number,
  cache: Map<string, boolean>,
): Promise<string[]> {
  const failed: string[] = []

  for (const step of steps) {
    const dir = join(worktreeCwd, step.pathPrefix)
    const cacheKey = await computePrepareCacheKey(dir, step.command)

    let ok: boolean
    if (cacheKey !== null && cache.has(cacheKey)) {
      ok = cache.get(cacheKey)!
    } else {
      ok = await runPrepareStep({ cwd: dir, command: step.command, timeoutMs })
      if (cacheKey !== null) cache.set(cacheKey, ok)
    }

    if (!ok) failed.push(`\`${step.command}\` in ${step.pathPrefix || '.'}`)
  }

  return failed
}

/**
 * Creates a `Reviewer` that runs the Codex CLI in read-only mode against a PR's head
 * commit and returns its review text.
 *
 * Invocation (learned the hard way running this in the Radiooooo v4 program):
 *
 *   cd <worktree> && codex exec --sandbox read-only -- "<prompt>" > out 2>/dev/null < /dev/null
 *
 * - stdin is always closed: with stdin open, `codex exec` prints "Reading additional
 *   input from stdin..." and never returns.
 * - It must run inside a git worktree checked out at the PR head so `git diff` resolves.
 * - The read-only sandbox cannot run tests, so its conclusions are analytical only.
 * - It bills a ChatGPT subscription (`~/.codex/auth.json`), not an API key — nothing in
 *   this adapter reads or sets an API key env var.
 * - The prompt is caller-influenced (a PR's title/body flow into it), so it is never
 *   trusted to be inert against codex's own argv parser: `--` always precedes it,
 *   terminating option parsing, so a prompt starting with `-`/`--` (e.g.
 *   `--dangerously-bypass-approvals-and-sandbox`) can only ever be positional text.
 *
 * argv is fixed by design: `[binary, 'exec', '--sandbox', 'read-only', ...typed flags
 * from `model`/`profile`, '--', prompt]`. There is no `extraArgs` and no way for a
 * caller to add, remove, or reorder an argv element — `model` and `profile` are
 * validated against a strict charset and can only ever render as their own
 * `--model`/`--profile` flag pair, never as something else, and the prompt can only
 * ever land after the `--` terminator.
 */
export function createCodexReviewer(config: CodexReviewerConfig = {}): Reviewer {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Every config value that ends up in a git/spawn call is read from `config` exactly
  // once, right here, into this single frozen snapshot. Every later use — argv,
  // `git -C`, `Bun.spawn`'s `cwd` — reads `resolvedOptions`, never `config` again, so
  // none of these can change (via a getter or a coercing object) between being
  // checked and being used.
  const resolvedOptions = Object.freeze({
    // Only a genuinely absent `binary` (`undefined`) falls back to the default —
    // `?? DEFAULT_BINARY` would also silently swallow an explicit `null`, which must
    // instead be rejected the same as any other non-string.
    binary: readRequiredPath('binary', config.binary === undefined ? DEFAULT_BINARY : config.binary),
    clonePath: readOptionalPath('clonePath', config.clonePath),
    worktreeRoot: readOptionalPath('worktreeRoot', config.worktreeRoot),
    model: readValidatedOption('model', config.model),
    profile: readValidatedOption('profile', config.profile),
  })

  const typedFlags: string[] = []
  if (resolvedOptions.model !== undefined) typedFlags.push('--model', resolvedOptions.model)
  if (resolvedOptions.profile !== undefined) typedFlags.push('--profile', resolvedOptions.profile)
  Object.freeze(typedFlags)

  // Owned by this Reviewer instance, not module-global (a fresh
  // createCodexReviewer() call — as every test makes — gets a fresh,
  // empty cache) and not per-call (persists across every review() call
  // this instance ever makes, which in the real gate loop is its whole
  // process lifetime) — see runPrepareSteps's own doc comment for why
  // that's the point.
  const prepareCache = new Map<string, boolean>()

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
        mergeBaseSha: input.mergeBaseSha,
      })

      try {
        // Runs BEFORE codex, outside its read-only sandbox entirely (this
        // is a plain, writable Bun.spawn — the sandbox flag below is
        // fixed and unaffected either way) — see
        // `ReviewInput.prepareSteps`'s own doc comment (floor/agents#32)
        // for the full rationale. Best-effort by construction:
        // `runPrepareSteps` never throws, so a prepare failure can only
        // ever change the prompt text below, never abort the review.
        const failedPrepareSteps = await runPrepareSteps(
          input.prepareSteps ?? [],
          worktree.cwd,
          input.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS,
          prepareCache,
        )

        // A single note line, prepended to the ORIGINAL prompt — never
        // codex's own stdout, and never the prepare step's own output
        // (runPrepareStep discards that structurally; see its doc
        // comment). Silent when every step succeeded (or none were
        // configured): a success has nothing worth telling the reviewer.
        const promptForCodex = failedPrepareSteps.length > 0
          ? `Note: the prepare step failed or timed out for ${failedPrepareSteps.join(', ')} — dependency-based commands (tests, typecheck) may not work in this sandbox.\n\n${input.prompt}`
          : input.prompt

        const rawOutput = await runCodex({
          binary: resolvedOptions.binary,
          typedFlags,
          timeoutMs,
          prompt: promptForCodex,
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
  // Fixed shape, no caller-extensible piece except the two typed, validated flags.
  // The prompt is caller-influenced (PR titles/bodies flow into it) and Bun.spawn's
  // array form only protects against a shell reinterpreting it — it does NOT stop
  // codex's own argv parser from treating a prompt that starts with `-`/`--` as
  // another flag. `--` terminates option parsing (verified against codex-cli 0.151.0:
  // `codex exec --sandbox read-only -- --this-is-not-a-real-flag` runs with that
  // string as the prompt, not a parse error — see packages/codex-cli/README.md), so
  // everything after it, including the prompt, is unconditionally positional.
  const args = [opts.binary, 'exec', '--sandbox', SANDBOX, ...opts.typedFlags, '--', opts.prompt]

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
