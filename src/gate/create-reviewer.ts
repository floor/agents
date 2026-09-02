// Builds the Reviewer `src/gate.ts` wires into the gate loop, from
// environment variables. Split out from src/gate.ts (which has top-level
// side effects — loading config, requiring GITHUB_TOKEN/GITHUB_OWNER — that
// run on import) so this piece stays a plain, side-effect-free module unit
// tests can import directly.

import { createFakeReviewer, type Reviewer } from '@floor-agents/core'
import { createCodexReviewer, type CodexReviewerConfig } from '@floor-agents/codex-cli'

const TIMEOUT_MS_RE = /^\d+$/

/** Parses an env var as a positive integer number of milliseconds. Unlike a
 *  bare `Number(...)`, this rejects anything that isn't a plain decimal
 *  integer string — `"0.5"`, `"1e3"`, `"0x10"`, `"-5"`, `""`, and whitespace
 *  all throw, not just non-finite/non-positive results — so a value that
 *  merely happens to coerce to a usable number can't silently pass. */
function parsePositiveIntegerMs(name: string, raw: string): number {
  if (!TIMEOUT_MS_RE.test(raw)) {
    throw new Error(`${name} must be a positive integer number of milliseconds — got ${JSON.stringify(raw)}`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds — got ${JSON.stringify(raw)}`)
  }
  return value
}

/** Builds `@floor-agents/codex-cli`'s `CodexReviewerConfig` from environment
 *  variables. Every key is optional — an unset var leaves the package's own
 *  default in place (see packages/codex-cli/README.md's Options table).
 *  An env var that is explicitly SET to an empty string is treated as an
 *  explicit (and, for most of these keys, invalid) value, not as unset —
 *  it is passed straight through to the package's own validation, which
 *  rejects an empty `binary`/`model`/`profile`/`clonePath`/`worktreeRoot`
 *  with a clear error, the same as any other malformed value; it is never
 *  silently treated the same as the variable being absent.
 *
 *  Note `clonePath` is optional here only in the sense that the package
 *  itself doesn't require it at construction time — the gate loop always
 *  calls `reviewer.review()` without a `worktreePath`, so in practice
 *  `GATE_CODEX_CLONE_PATH` must be set for `codex` review to actually run;
 *  an unset one surfaces as a clear error from the package the first time a
 *  review is attempted, not a silent no-op. */
export function codexReviewerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): CodexReviewerConfig {
  const config: { -readonly [K in keyof CodexReviewerConfig]?: CodexReviewerConfig[K] } = {}

  if (env.GATE_CODEX_BINARY !== undefined) config.binary = env.GATE_CODEX_BINARY
  if (env.GATE_CODEX_MODEL !== undefined) config.model = env.GATE_CODEX_MODEL
  if (env.GATE_CODEX_PROFILE !== undefined) config.profile = env.GATE_CODEX_PROFILE
  if (env.GATE_CODEX_CLONE_PATH !== undefined) config.clonePath = env.GATE_CODEX_CLONE_PATH
  if (env.GATE_CODEX_WORKTREE_ROOT !== undefined) config.worktreeRoot = env.GATE_CODEX_WORKTREE_ROOT
  if (env.GATE_CODEX_TIMEOUT_MS !== undefined) {
    config.timeoutMs = parsePositiveIntegerMs('GATE_CODEX_TIMEOUT_MS', env.GATE_CODEX_TIMEOUT_MS)
  }

  return config
}

/** Selects and constructs the Reviewer for `GATE_REVIEWER` (default `codex`).
 *  `codex` is wired directly to `@floor-agents/codex-cli`'s `createCodexReviewer`
 *  — see packages/codex-cli/README.md for its exact invocation contract (fixed
 *  argv, worktree lifecycle, the "## Reviewer agent (Codex)" header extraction,
 *  and why there is no caller-extensible argv). `fake` smoke-tests the loop
 *  end-to-end without shelling out to a real reviewer. */
export function createReviewer(env: Record<string, string | undefined> = process.env): Reviewer {
  const kind = env.GATE_REVIEWER ?? 'codex'
  switch (kind) {
    case 'codex':
      return createCodexReviewer(codexReviewerConfigFromEnv(env))
    case 'fake':
      return createFakeReviewer({ vendor: 'fake' })
    default:
      throw new Error(
        `Unknown GATE_REVIEWER "${kind}". Supported: codex, fake. ` +
        `Wire in another Reviewer implementation here once available.`,
      )
  }
}
