// Selects which "prepare" command(s) should run in a Reviewer's worktree
// before it reviews a PR (floor/agents#32): a per-path-prefix shell command
// (e.g. `web/` -> `bun install --frozen-lockfile`) that gets a real package
// manager install done so a worktree-creating Reviewer's OWN later commands
// (`bun test`, `bun run typecheck`, ...) have something to run against,
// rather than failing on a missing `node_modules` every single review.
//
// This module only SELECTS which configured commands apply to a given PR
// (same "does a changed file start with this prefix" style as
// checklists.ts's own rule selection) — it never runs anything itself. The
// actual execution, caching, and timeout enforcement is the Reviewer's own
// job (currently only @floor-agents/codex-cli's adapter; see
// packages/codex-cli/src/adapter.ts), since that's the package that
// actually creates a local worktree to run commands in. gate/loop.ts wires
// the two together: select here, hand the result to `Reviewer.review()` via
// `ReviewInput.prepareSteps`.
//
// The prepare `command` string comes from THIS repo's own operator-edited
// YAML config (config/gate/gate.yaml), never from anything PR-controlled —
// unlike the review prompt (which embeds a PR's title/body) or codex-cli's
// `model`/`profile` flags, there is no argv-injection concern here: it is
// trusted the same way `promptTemplatePath` or `clonePath` already are.

export type PrepareRule = {
  /** A changed file's path must start with this string for the rule to
   *  match (e.g. `"web/"` matches `"web/src/app.ts"`). Plain prefix, not a
   *  glob or regex — same simplicity as checklists.ts's `pathContains`,
   *  just anchored to the start instead of "anywhere". */
  readonly pathPrefix: string
  /** Shell command run from `<worktree>/<pathPrefix>` before the review.
   *  The literal value `"none"` (case-insensitive, surrounding whitespace
   *  ignored) or an empty string is an explicit no-op — lets a config
   *  document "this path needs no prepare step" (e.g. `ios/: none`)
   *  without a separate on/off field. */
  readonly command: string
}

export type PrepareConfig = {
  readonly rules: readonly PrepareRule[]
  /** Kill a selected prepare command and treat it as failed after this
   *  many ms, if it hasn't finished. Applies per command, not to the total
   *  of every selected command for one review. */
  readonly timeoutMs: number
}

/** 2 minutes — generous enough for a real `bun install`/`npm ci` on a
 *  mid-sized package without the worktree sitting idle for the whole 15
 *  minute review timeout on a genuinely stuck install. */
export const DEFAULT_PREPARE_TIMEOUT_MS = 120_000

export const DEFAULT_PREPARE_CONFIG: PrepareConfig = { rules: [], timeoutMs: DEFAULT_PREPARE_TIMEOUT_MS }

/** True for the two spellings ("none", "") that mark a rule as an
 *  intentional no-op — see `PrepareRule.command`'s own doc comment. */
function isNoopCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase()
  return normalized === '' || normalized === 'none'
}

/** Returns the rules whose `pathPrefix` matches at least one of
 *  `changedFiles`, in config order, deduplicated by `pathPrefix` (a
 *  duplicate prefix later in the list is dropped, not re-run) — a no-op
 *  rule (`isNoopCommand`) never matches, regardless of `changedFiles`, so
 *  an explicit `ios/: none` entry costs nothing beyond documenting intent.
 *  Returns `[]` when nothing configured matches, same as an empty/absent
 *  `rules` array — a caller with no prepare config needs no special
 *  handling. */
export function selectPrepareCommands(
  rules: readonly PrepareRule[],
  changedFiles: readonly string[],
): PrepareRule[] {
  const seenPrefixes = new Set<string>()
  const selected: PrepareRule[] = []

  for (const rule of rules) {
    if (isNoopCommand(rule.command)) continue
    if (seenPrefixes.has(rule.pathPrefix)) continue
    if (changedFiles.some(f => f.startsWith(rule.pathPrefix))) {
      seenPrefixes.add(rule.pathPrefix)
      selected.push(rule)
    }
  }

  return selected
}
