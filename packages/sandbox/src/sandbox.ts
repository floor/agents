/**
 * Operating-system containment for agent CLIs.
 *
 * Agent CLIs cannot be trusted to confine themselves. Measured on cursor-agent:
 * with `--trust` its file-edit tool wrote to a sibling folder and to an absolute
 * path outside its working directory, and neither `--trust` nor `--force` has a
 * read-only mode. Inside `sandbox-exec` the same requests failed — "Write
 * permission denied" from the edit tool, "operation not permitted" from the
 * shell — while writes inside the allowed folder still worked.
 *
 * So containment is not asked of the model. Each agent process is started under
 * a macOS sandbox profile written for that run:
 *
 * - writes under the home directory are denied, except the run's own writable
 *   folders and the tool's state directories;
 * - reads of credential stores and `.env` files are denied everywhere;
 * - everything else (reads elsewhere, network, processes) is allowed.
 *
 * Reads outside the deny list and network access are NOT contained: an agent can
 * still read what the user can read and send it to its model provider.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * The sandbox matches resolved paths. macOS symlinks /tmp and /var into /private,
 * so a rule written against the unresolved path silently never applies — every
 * write and read it was meant to stop goes through. Resolve anything that exists.
 */
const real = (p: string): string => {
  try { return realpathSync(p) } catch { return p }
}

/**
 * What runs in the sandbox, which decides the state directories that stay
 * writable. `project` is the project's own setup and verification commands:
 * they execute code the agent may have written — its tests, a postinstall
 * script — so they are contained like the agent.
 */
export type SandboxTool = 'cursor' | 'claude' | 'project'

export type SandboxSpec = {
  /** The home directory whose writes are denied by default. */
  readonly home: string
  /** Directories the agent may write, in addition to its tool's state. */
  readonly writable: readonly string[]
  /** Directories the agent may not read at all. */
  readonly denyRead: readonly string[]
  /** Regex sources matched against any path; matching paths may not be read. */
  readonly denyReadPatterns: readonly string[]
  /** Which CLI runs, so its own state directories stay writable. */
  readonly tool: SandboxTool
}

/** Where each CLI keeps state it must be able to write, relative to home. */
export const toolState: Record<SandboxTool, { readonly dirs: readonly string[]; readonly filePrefixes: readonly string[] }> = {
  cursor: {
    dirs: ['.cursor', '.local/share/cursor-agent', 'Library/Application Support/Cursor', 'Library/Caches'],
    filePrefixes: [],
  },
  claude: {
    dirs: ['.claude', 'Library/Caches'],
    // ~/.claude.json and the lock and backup files written beside it.
    filePrefixes: ['.claude.json'],
  },
  // Package-manager and build caches that install and test commands write.
  project: {
    dirs: ['.bun', '.npm', '.cache', 'Library/Caches', '.cargo/registry', '.cargo/git', 'go/pkg/mod'],
    filePrefixes: [],
  },
}

/** Credential stores no agent needs to read, relative to home. */
export const DEFAULT_DENY_READ: readonly string[] = ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.docker']

/** `.env`, `.env.local`, `.env.production` … anywhere on disk. */
export const DENY_READ_PATTERNS: readonly string[] = ['/\\.env(\\.[^/]*)?$']

const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const regexEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const regexLiteral = (source: string): string => `#${quote(source)}`

/**
 * The SBPL profile for one run. Rules are evaluated last-match-wins, so the
 * broad home write denial comes first and the specific allowances after it; the
 * read denials come last so no allowance can reopen a credential store.
 */
export function sandboxProfile(spec: SandboxSpec): string {
  const state = toolState[spec.tool]
  const lines = [
    '(version 1)',
    '(allow default)',
    `(deny file-write* (subpath ${quote(spec.home)}))`,
    ...spec.writable.map(dir => `(allow file-write* (subpath ${quote(dir)}))`),
    ...state.dirs.map(dir => `(allow file-write* (subpath ${quote(join(spec.home, dir))}))`),
    ...state.filePrefixes.map(f => `(allow file-write* (regex ${regexLiteral(`^${regexEscape(join(spec.home, f))}`)}))`),
    ...spec.denyRead.map(dir => `(deny file-read* (subpath ${quote(dir)}))`),
    ...spec.denyReadPatterns.map(p => `(deny file-read* (regex ${regexLiteral(p)}))`),
  ]
  return lines.join('\n')
}

type Env = Readonly<Record<string, string | undefined>>

/** A comma-separated path list from the environment, `~` expanded. */
function pathList(raw: string | undefined, home: string): string[] {
  return (raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => (p.startsWith('~') ? join(home, p.slice(1)) : p))
}

/** Extra unreadable paths from FLOOR_AGENTS_DENY_READ. */
function extraDenyRead(env: Env, home: string): string[] {
  return pathList(env.FLOOR_AGENTS_DENY_READ, home)
}

/** Extra writable paths from FLOOR_AGENTS_SANDBOX_WRITABLE, for builds that write elsewhere. */
function extraWritable(env: Env, home: string): string[] {
  return pathList(env.FLOOR_AGENTS_SANDBOX_WRITABLE, home)
}

function baseSpec(tool: SandboxTool, writable: readonly string[], env: Env, home: string): SandboxSpec {
  const h = real(home)
  return {
    home: h,
    tool,
    writable: writable.map(real),
    denyRead: [...DEFAULT_DENY_READ.map(d => join(h, d)), ...extraDenyRead(env, h)].map(real),
    denyReadPatterns: DENY_READ_PATTERNS,
  }
}

/** A reviewer reads the repository and writes nothing but its tool's state. */
export function reviewerSandbox(tool: SandboxTool, env: Env = process.env, home = homedir()): SandboxSpec {
  return baseSpec(tool, [], env, home)
}

/** An implementer may also write its worktree and that worktree's git metadata. */
export function implementerSandbox(tool: SandboxTool, writable: readonly string[], env: Env = process.env, home = homedir()): SandboxSpec {
  return baseSpec(tool, [...writable, ...extraWritable(env, home)], env, home)
}

/** A project setup or verification command: the checkout, plus package caches. */
export function projectCommandSandbox(writable: readonly string[], env: Env = process.env, home = homedir()): SandboxSpec {
  return baseSpec('project', [...writable, ...extraWritable(env, home)], env, home)
}

export type SandboxOptions = {
  readonly env?: Env
  readonly platform?: NodeJS.Platform
  readonly which?: (bin: string) => string | null
}

/**
 * The argv that runs `argv` inside the sandbox.
 *
 * Fails closed: where sandbox-exec is unavailable the run is refused, not run
 * uncontained. FLOOR_AGENTS_SANDBOX=off is the one explicit way to accept that
 * risk, and it is meant for development, not for agents on real repositories.
 */
export function sandboxed(argv: readonly string[], spec: SandboxSpec, opts: SandboxOptions = {}): string[] {
  const env = opts.env ?? process.env
  if (env.FLOOR_AGENTS_SANDBOX === 'off') return [...argv]
  const platform = opts.platform ?? process.platform
  const which = opts.which ?? ((bin: string) => Bun.which(bin))
  if (platform !== 'darwin' || !which('sandbox-exec')) {
    throw new Error(
      `Refusing to run ${argv[0]} without a sandbox: sandbox-exec is unavailable on ${platform}. ` +
      'Set FLOOR_AGENTS_SANDBOX=off to run agents uncontained.',
    )
  }
  return ['sandbox-exec', '-p', sandboxProfile(spec), ...argv]
}
