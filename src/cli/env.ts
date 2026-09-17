/**
 * Per-project secrets beside the manifest.
 *
 * Bun loads `.env` from the directory a process starts in. Runs start in the
 * project's checkout, so the engine's own `.env` — with the Telegram bot and
 * chat, say — was never in their environment: a run posted to GitHub and
 * nowhere else while the committee scripts, started from the engine's
 * directory, reached the channel. And one file cannot hold two projects'
 * chats anyway.
 *
 * So the manifest's directory carries its own: `.agents/.env`, ignored by the
 * same rule that ignores the worktrees and the run state. A variable already
 * in the environment wins, as with any dotenv: the shell is the operator's
 * override, the file is the project's default.
 */

import { dirname, join, resolve } from 'node:path'

/** KEY=VALUE lines; comments, blanks and surrounding quotes are dropped. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

/** The env file that belongs to a manifest: `.env` in its directory. */
export function projectEnvPath(configPath: string): string {
  return join(dirname(resolve(configPath)), '.env')
}

/**
 * Load the manifest's `.env` into `env`, without overriding what is set.
 * Returns the keys it added, so the log can say which without saying what.
 */
export async function loadProjectEnv(configPath: string, env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const file = Bun.file(projectEnvPath(configPath))
  if (!(await file.exists())) return []
  const added: string[] = []
  for (const [key, value] of Object.entries(parseEnv(await file.text()))) {
    if (env[key] !== undefined) continue
    env[key] = value
    added.push(key)
  }
  return added
}
