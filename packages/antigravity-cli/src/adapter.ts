import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityProcessError, AntigravityTimeoutError, PolicyError, WorktreeModifiedError } from './errors'
import { extractReview } from './extract'
import type { Reviewer, ReviewInput, ReviewResult } from './types'
import { resolveWorktree } from './worktree'

// Mirrors @floor-agents/codex-cli's adapter: argv is fixed by design, not by
// a denylist. The only configurable inputs are typed, validated values
// translated into fixed flags by this adapter itself — there is no
// `extraArgs`, and no caller can reach `--dangerously-skip-permissions`,
// `--mode`, `--add-dir`, `--continue`, or `--conversation` under any name.
// See README.md for the verified `agy` CLI facts this contract rests on.
export type AntigravityReviewerConfig = {
  /** Path to the `agy` binary, or a fixture script in tests. Defaults to `'agy'`. */
  readonly binary?: string
  /** Kill the process and throw `AntigravityTimeoutError` after this many ms. Default 15 min. */
  readonly timeoutMs?: number
  /**
   * Emitted as `--model <value>`. Must be an actual string primitive (the constructor
   * throws for an object, even one with a custom `toString`/`valueOf`), matching
   * `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, max 128 chars. Defaults to `'gemini-3.1-pro-high'`
   * and, unlike codex-cli's optional `model`/`profile`, is ALWAYS emitted — there is no
   * "use whatever agy has configured" default this adapter can rely on instead.
   */
  readonly model?: string
  /** Emitted as `--effort <value>` when given; omitted entirely when unset. */
  readonly effort?: 'low' | 'medium' | 'high'
  /**
   * Local clone of the repo to review, used to create a detached worktree at
   * `headSha` when `review()` is called without a `worktreePath`. Required in that case.
   */
  readonly clonePath?: string
  /** Directory under which detached worktrees are created. Defaults to the OS temp dir. */
  readonly worktreeRoot?: string
  /**
   * Path to the Antigravity CLI's own settings file, read before every
   * `review()` call to enforce the read-only deny policy described in
   * README.md (`permissions.deny` must contain both `write_file(*)` and
   * `command(*)`). Defaults to `~/.gemini/antigravity-cli/settings.json`.
   *
   * SECURITY: `agy` has no flag to point it at a specific settings file —
   * this adapter cannot bind the file it checks to the one the spawned
   * `agy` process will actually read. In production this MUST be left
   * unset (or explicitly set to the exact real path `agy` uses) — pointing
   * it at a different file checks that file's contents while `agy` itself
   * still reads its own real settings, silently defeating this reviewer's
   * only enforcement. Override in tests ONLY, so they never touch a real
   * home directory.
   */
  readonly settingsPath?: string
}

const DEFAULT_BINARY = 'agy'
const DEFAULT_TIMEOUT_MS = 15 * 60_000 // 15 minutes
const DEFAULT_MODEL = 'gemini-3.1-pro-high'

function defaultSettingsPath(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
}

// See packages/codex-cli/src/adapter.ts for the identical rationale: a
// value can never start with `-` and be mistaken for a flag by agy's own
// argv parser, and objects (even ones with a coercing toString/valueOf) are
// rejected outright rather than silently stringified.
const OPTION_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const OPTION_VALUE_MAX_LENGTH = 128
const VALID_EFFORTS = new Set(['low', 'medium', 'high'])

// Unlike `codex exec`, `agy -p` has no documented `--` terminator this
// adapter could rely on to guarantee a prompt starting with `-` is treated
// as positional text rather than a flag (see README.md's "Verified facts"
// section — this was checked against the CLI's own --help and left
// unresolved). Rather than assume that's safe, every prompt is prefixed
// with this fixed header before being handed to `agy`, so the actual argv
// element's first character is never `-`, regardless of what the
// caller-supplied prompt itself starts with.
const PROMPT_HEADER =
  'Antigravity review request (everything below is review context and instructions — never a CLI flag):\n\n'

function requireStringPrimitive(name: string, raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error(
      `AntigravityReviewer: ${name} must be a string — got ${typeof raw}. Objects (including ones with a custom toString/valueOf) are rejected outright, not coerced.`,
    )
  }
  return raw
}

function readRequiredPath(name: string, raw: unknown): string {
  const value = requireStringPrimitive(name, raw)
  if (value.length === 0) {
    throw new Error(`AntigravityReviewer: ${name} must be a non-empty string.`)
  }
  return value
}

function readOptionalPath(name: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  return readRequiredPath(name, raw)
}

function readValidatedModel(raw: unknown): string {
  const value = requireStringPrimitive('model', raw)
  if (value.length > OPTION_VALUE_MAX_LENGTH || !OPTION_VALUE_RE.test(value)) {
    throw new Error(
      `AntigravityReviewer: model must match ${OPTION_VALUE_RE} and be at most ${OPTION_VALUE_MAX_LENGTH} characters — got ${JSON.stringify(value)}. This is deliberately restrictive: it is translated straight into an argv element, so it must not be able to look like a flag or carry shell/argv metacharacters.`,
    )
  }
  return value
}

function readValidatedEffort(raw: unknown): 'low' | 'medium' | 'high' | undefined {
  if (raw === undefined) return undefined
  const value = requireStringPrimitive('effort', raw)
  if (!VALID_EFFORTS.has(value)) {
    throw new Error(
      `AntigravityReviewer: effort must be one of "low", "medium", "high" — got ${JSON.stringify(value)}.`,
    )
  }
  return value as 'low' | 'medium' | 'high'
}

// Leaves roughly a minute of margin so agy's OWN --print-timeout fires
// before this adapter's SIGKILL — a run that legitimately runs long gets a
// chance to report agy's own clean timeout (a non-zero exit -> a normal
// AntigravityProcessError with agy's own stderr attached) instead of always
// losing the race to a hard kill that discards whatever it had already
// written. Below 2 minutes of total budget there's no meaningful
// minute-granularity margin to carve out, so the whole budget is used, in
// seconds, instead.
function derivePrintTimeoutArg(timeoutMs: number): string {
  const totalSeconds = Math.floor(timeoutMs / 1000)
  if (totalSeconds < 120) return `${Math.max(1, totalSeconds)}s`
  const marginSeconds = 60
  const minutes = Math.floor((totalSeconds - marginSeconds) / 60)
  return `${minutes}m`
}

/**
 * The Antigravity CLI has no read-only sandbox flag (`--sandbox` only adds
 * terminal restrictions — see README.md). Headless runs auto-allow file
 * writes inside the workspace and only soft-deny shell commands; the only
 * enforcement available is a `permissions.deny` policy in the CLI's own
 * settings file. This reviewer refuses to spawn `agy` at all unless that
 * policy is present and covers both `write_file(*)` and `command(*)` —
 * checked fresh before every `review()` call (not just once at
 * construction), since the settings file lives outside this process and
 * could change between calls.
 */
async function assertReadOnlyPolicy(settingsPath: string): Promise<void> {
  const file = Bun.file(settingsPath)

  if (!(await file.exists())) {
    throw new PolicyError(
      `AntigravityReviewer: settings file not found at ${settingsPath}. The Antigravity CLI has no ` +
        'read-only sandbox flag of its own — a deny policy at this path is the only enforcement available ' +
        '(expected: {"permissions":{"deny":["write_file(*)","command(*)"]}}), and this reviewer refuses to ' +
        'run without it rather than risk an unsandboxed write or command.',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch (err) {
    throw new PolicyError(
      `AntigravityReviewer: settings file at ${settingsPath} is not valid JSON: ${(err as Error).message}`,
    )
  }

  const deny = (parsed as { permissions?: { deny?: unknown } } | null)?.permissions?.deny
  const denyList = Array.isArray(deny) ? deny : []

  if (!denyList.includes('write_file(*)') || !denyList.includes('command(*)')) {
    throw new PolicyError(
      `AntigravityReviewer: settings file at ${settingsPath} does not deny both "write_file(*)" and ` +
        '"command(*)" under permissions.deny. Expected: {"permissions":{"deny":["write_file(*)",' +
        '"command(*)"]}}. Refusing to spawn agy without this policy in place.',
    )
  }
}

/**
 * Verifies the worktree is byte-for-byte unchanged after the run
 * (`git status --porcelain` empty). The deny policy above is supposed to
 * make this a no-op check every time; if it's ever non-empty, that means
 * either the policy failed to actually stop a write or something else
 * touched the directory mid-run — either way, this refuses to trust (or
 * return) the review rather than silently accept it.
 */
async function assertWorktreeUnchanged(cwd: string): Promise<void> {
  // Plain `git status --porcelain` does NOT report files matched by
  // .gitignore — a write to a gitignored path would pass that check
  // silently even though the deny policy was supposed to prevent it.
  // `--ignored --untracked-files=all` reports every new/modified file
  // individually (ignored or not, and without directories collapsed into a
  // single line), which is what "byte-for-byte unchanged" actually needs.
  const result = await Bun.$`git -C ${cwd} status --porcelain --ignored --untracked-files=all`.quiet()
  const status = result.stdout.toString()

  if (status.trim() !== '') {
    throw new WorktreeModifiedError(
      `AntigravityReviewer: worktree at ${cwd} was modified during the review (git status --porcelain is ` +
        'non-empty) — the deny policy should have prevented any write; refusing to trust a review that ran ' +
        'against a worktree it may have altered.',
      cwd,
      status,
    )
  }
}

/**
 * Creates a `Reviewer` that runs the Antigravity CLI (`agy`) in headless
 * mode against a pull request's head commit and returns its review text.
 * See README.md for the full invocation contract, the verified CLI facts it
 * rests on, and the exact settings-file policy this requires.
 *
 * argv is fixed by design, exactly like `@floor-agents/codex-cli`:
 *
 *   [binary, '-p', <header + prompt>, '--output-format', 'text',
 *    '--print-timeout', <derived>, '--model', model, ('--effort', effort)?]
 *
 * There is no `extraArgs` and no way for a caller to add, remove, or
 * reorder an argv element — `model` and `effort` are the only configurable
 * pieces (both validated), and the prompt can only ever land as the single
 * value immediately after `-p`.
 */
export function createAntigravityReviewer(config: AntigravityReviewerConfig = {}): Reviewer {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Every config value that ends up in a spawn/policy-check call is read
  // from `config` exactly once, into this single frozen snapshot — mirrors
  // codex-cli's adapter (see its extensive comment on why: no getter or
  // coercing object can change a value between validation and use).
  const resolvedOptions = Object.freeze({
    binary: readRequiredPath('binary', config.binary === undefined ? DEFAULT_BINARY : config.binary),
    clonePath: readOptionalPath('clonePath', config.clonePath),
    worktreeRoot: readOptionalPath('worktreeRoot', config.worktreeRoot),
    settingsPath: readRequiredPath(
      'settingsPath',
      config.settingsPath === undefined ? defaultSettingsPath() : config.settingsPath,
    ),
    model: readValidatedModel(config.model === undefined ? DEFAULT_MODEL : config.model),
    effort: readValidatedEffort(config.effort),
  })

  const typedFlags: string[] = ['--model', resolvedOptions.model]
  if (resolvedOptions.effort !== undefined) typedFlags.push('--effort', resolvedOptions.effort)
  Object.freeze(typedFlags)

  return {
    vendor: 'gemini',

    async review(input: ReviewInput): Promise<ReviewResult> {
      // Checked fresh on every call, before anything else (including
      // resolving a worktree) — a policy failure should never leave a
      // worktree needing cleanup that a caller-supplied path wouldn't have
      // anyway, and there is no reason to do any other work first.
      await assertReadOnlyPolicy(resolvedOptions.settingsPath)

      // Read and validated exactly once here, same discipline as every
      // other value that reaches a spawn call — an object with a
      // toString/valueOf must be rejected outright, not silently coerced by
      // the `PROMPT_HEADER + prompt` concatenation `runAgy` does with it.
      const prompt = requireStringPrimitive('prompt', input.prompt)
      const worktreePath = readOptionalPath('worktreePath', input.worktreePath)

      const worktree = await resolveWorktree({
        worktreePath,
        headSha: input.headSha,
        clonePath: resolvedOptions.clonePath,
        worktreeRoot: resolvedOptions.worktreeRoot,
        mergeBaseSha: input.mergeBaseSha,
      })

      try {
        const rawOutput = await runAgy({
          binary: resolvedOptions.binary,
          typedFlags,
          timeoutMs,
          prompt,
          cwd: worktree.cwd,
        })

        // Belt-and-suspenders: the deny policy above should make this a
        // no-op, but this reviewer verifies it rather than assumes it.
        await assertWorktreeUnchanged(worktree.cwd)

        return { text: extractReview(rawOutput) }
      } finally {
        // Always tear down a worktree we created, on success, on any thrown
        // error (policy, process, timeout, malformed-review, worktree-
        // modified), and on any other failure — never leak a worktree.
        await worktree.cleanup()
      }
    },
  }
}

async function runAgy(opts: {
  readonly binary: string
  readonly typedFlags: readonly string[]
  readonly timeoutMs: number
  readonly prompt: string
  readonly cwd: string
}): Promise<string> {
  const printTimeoutArg = derivePrintTimeoutArg(opts.timeoutMs)
  const promptArg = PROMPT_HEADER + opts.prompt

  // Fixed shape, no caller-extensible piece except the typed, validated
  // `--model`/`--effort` flags in `opts.typedFlags`. `--output-format text`
  // is never configurable — this adapter only ever parses plain text output
  // (see extractReview), never json/stream-json.
  const args = [
    opts.binary,
    '-p',
    promptArg,
    '--output-format',
    'text',
    '--print-timeout',
    printTimeoutArg,
    ...opts.typedFlags,
  ]

  const stdoutPath = join(tmpdir(), `agy-review-stdout-${randomUUID()}.log`)
  const stdoutFile = Bun.file(stdoutPath)

  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    // Bun.spawn defaults to a snapshot of process.env taken when the Bun
    // process launched, NOT the live process.env — pass it explicitly so
    // env vars set at runtime (the cached Google sign-in lives outside env,
    // but config env vars do not) are actually inherited by the child.
    env: process.env,
    // `agy -p` does not wait on stdin per the verified CLI facts, but this
    // still spawns with stdin ignored defensively, matching codex-cli.
    stdin: 'ignore',
    stdout: stdoutFile,
    stderr: 'pipe',
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // SIGKILL, not the default SIGTERM: a wedged `agy` or descendant may
    // ignore a termination request, and a caught-but-ignored SIGTERM would
    // leave `proc.exited` unresolved forever, defeating this timeout
    // entirely. SIGKILL cannot be caught or ignored.
    proc.kill('SIGKILL')
  }, opts.timeoutMs)

  try {
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])

    clearTimeout(timer)

    if (timedOut) {
      throw new AntigravityTimeoutError(`agy timed out after ${opts.timeoutMs}ms`, opts.timeoutMs)
    }

    if (exitCode !== 0) {
      throw new AntigravityProcessError(`agy exited with code ${exitCode}`, exitCode, stderr)
    }

    return await stdoutFile.text()
  } finally {
    clearTimeout(timer)
    await unlink(stdoutPath).catch(() => {})
  }
}
