import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

const WORKTREE_DIR = '.worktrees'

export type Worktree = {
  readonly path: string
  readonly branch: string
}

export async function createWorktree(branch: string): Promise<Worktree> {
  const dir = join(process.cwd(), WORKTREE_DIR)
  await mkdir(dir, { recursive: true })

  const safeName = branch.replace(/\//g, '-')
  const worktreePath = join(dir, safeName)

  // Remove stale worktree if it exists
  try {
    await Bun.$`git worktree remove ${worktreePath} --force`.quiet()
  } catch {}

  // Fetch the branch from remote
  try {
    await Bun.$`git fetch origin ${branch}`.quiet()
  } catch {}

  // Create the worktree
  await Bun.$`git worktree add ${worktreePath} ${branch}`.quiet()

  console.log(`[worktree] created: ${worktreePath} → ${branch}`)
  return { path: worktreePath, branch }
}

export async function commitAndPushWorktree(
  worktree: Worktree,
  message: string,
): Promise<string | null> {
  try {
    // Check for uncommitted changes
    const status = await Bun.$`git -C ${worktree.path} status --porcelain`.quiet()
    const statusText = status.stdout.toString().trim()

    if (statusText) {
      // Stage and commit uncommitted changes
      await Bun.$`git -C ${worktree.path} add -A`.quiet()
      await Bun.$`git -C ${worktree.path} commit -m ${message}`.quiet()
      console.log('[worktree] committed uncommitted changes')
    }

    // Check if there are unpushed commits (Claude Code may have already committed)
    const logResult = await Bun.$`git -C ${worktree.path} log origin/${worktree.branch}..HEAD --oneline`.quiet()
    const unpushed = logResult.stdout.toString().trim()

    if (!unpushed && !statusText) {
      console.log('[worktree] no changes to commit or push')
      return null
    }

    // Get commit SHA
    const shaResult = await Bun.$`git -C ${worktree.path} rev-parse HEAD`.quiet()
    const sha = shaResult.stdout.toString().trim()

    // Push
    await Bun.$`git -C ${worktree.path} push origin ${worktree.branch}`.quiet()

    const commitCount = unpushed ? unpushed.split('\n').length : 1
    console.log(`[worktree] pushed ${commitCount} commit(s): ${sha.slice(0, 8)}`)
    return sha
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() ?? ''
    const stdout = err.stdout?.toString?.() ?? ''
    console.error(`[worktree] commit/push failed: ${stderr || stdout || err.message}`)
    throw err
  }
}

export async function removeWorktree(worktree: Worktree): Promise<void> {
  try {
    await Bun.$`git worktree remove ${worktree.path} --force`.quiet()
    console.log(`[worktree] removed: ${worktree.path}`)
  } catch (err) {
    console.error(`[worktree] failed to remove ${worktree.path}:`, err)
  }
}
