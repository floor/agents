import { join, resolve } from 'node:path'
import { mkdir, mkdtemp } from 'node:fs/promises'

export type Worktree = {
  readonly path: string
  readonly branch: string
  readonly initialSha: string
}

export async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  const timeout = setTimeout(() => proc.kill('SIGKILL'), 60_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]).finally(() => clearTimeout(timeout))
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`)
  return stdout.trimEnd()
}

export async function createWorktree(branch: string, repoPath = process.cwd()): Promise<Worktree> {
  const root = resolve(repoPath)
  await gitText(root, ['check-ref-format', '--branch', branch])
  if (['main', 'master', 'develop', 'production'].includes(branch)) throw new Error(`Protected branch: ${branch}`)
  // Refresh branches first created through the API; never reuse a stale local branch.
  await gitText(root, ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`])
  const initialSha = await gitText(root, ['rev-parse', `refs/remotes/origin/${branch}`])
  // Beside the manifest and the run state, so one ignore rule (.agents/*) covers all of it.
  const dir = join(root, '.agents', 'worktrees')
  await mkdir(dir, { recursive: true })
  const path = await mkdtemp(join(dir, `${branch.replace(/[^a-zA-Z0-9-]/g, '-')}-`))
  await gitText(root, ['worktree', 'add', '--detach', path, initialSha])
  return { path, branch, initialSha }
}

/**
 * Reopen a worktree left on disk after a crash so uncommitted repair work is
 * not discarded. `initialSha` is the checkout the engine recorded — never
 * `HEAD`, which the agent can move with a commit or checkout.
 */
export async function reopenWorktree(path: string, branch: string, initialSha: string): Promise<Worktree | null> {
  if (!path || !branch || !initialSha) return null
  try {
    const inside = await gitText(path, ['rev-parse', '--is-inside-work-tree'])
    if (inside !== 'true') return null
    await gitText(path, ['cat-file', '-e', `${initialSha}^{commit}`])
    return { path, branch, initialSha }
  } catch {
    return null
  }
}

export async function snapshotWorktree(worktree: Worktree): Promise<string> {
  await gitText(worktree.path, ['add', '-A'])
  return gitText(worktree.path, ['write-tree'])
}

export async function commitWorktree(worktree: Worktree, message: string, expectedTree?: string): Promise<string | null> {
  const tree = await snapshotWorktree(worktree)
  if (expectedTree && tree !== expectedTree) throw new Error('Workspace changed after verification; refusing to commit')
  const initialTree = await gitText(worktree.path, ['rev-parse', `${worktree.initialSha}^{tree}`])
  if (tree === initialTree) return null
  // Publish the validated tree, excluding agent-created intermediate commits.
  return gitText(worktree.path, ['commit-tree', tree, '-p', worktree.initialSha, '-m', message])
}

export async function pushWorktree(worktree: Worktree, sha: string): Promise<void> {
  await gitText(worktree.path, ['push', 'origin', `${sha}:refs/heads/${worktree.branch}`])
}

export async function commitAndPushWorktree(worktree: Worktree, message: string): Promise<string | null> {
  const sha = await commitWorktree(worktree, message)
  if (sha) await pushWorktree(worktree, sha)
  return sha
}

export async function removeWorktree(worktree: Worktree): Promise<void> {
  try {
    await gitText(worktree.path, ['worktree', 'remove', worktree.path, '--force'])
  } catch (err) {
    console.error(`[worktree] failed to remove ${worktree.path}:`, err)
  }
}
