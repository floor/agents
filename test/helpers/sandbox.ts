let cached: boolean | undefined

/**
 * Whether sandbox-exec can actually apply a profile here.
 *
 * `Bun.which('sandbox-exec')` is not enough: the engine verifies its own PRs
 * inside a sandbox, and macOS refuses to nest sandbox-exec (exit 71) even
 * though the binary is on PATH.
 */
export function sandboxAvailable(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const useCache = env === process.env && platform === process.platform
  if (useCache && cached !== undefined) return cached
  const available = platform === 'darwin' && probe(env)
  if (useCache) cached = available
  return available
}

function probe(env: Readonly<Record<string, string | undefined>>): boolean {
  try {
    const result = Bun.spawnSync(
      ['sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true'],
      { stdout: 'ignore', stderr: 'ignore', env: { ...env } },
    )
    return result.exitCode === 0
  } catch {
    return false
  }
}
