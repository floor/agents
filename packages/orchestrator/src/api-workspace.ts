import { dirname, join } from 'node:path'
import { lstat, mkdir } from 'node:fs/promises'
import type { ExecutionState } from '@floor-agents/core'
import type { PipelineDeps } from './pipeline.ts'
import { createWorktree, removeWorktree } from './worktree.ts'
import { prepareWorkspace, verifyAndCommit, resolveBaseSha } from './verified-commit.ts'

export async function commitApiWorkspace(state: ExecutionState, deps: PipelineDeps, message: string): Promise<ExecutionState> {
  const worktree = await createWorktree(state.branchName!, deps.company.project.root)
  state = { ...state, workspacePath: worktree.path, baseSha: await resolveBaseSha(worktree, deps.company.project, state), verification: undefined }
  await deps.stateStore.save(state)
  await prepareWorkspace(worktree, deps.company.project)
  for (const file of state.parsedOutput!.files) {
    if (file.path.split('/').some(part => part === '.git' || part === '.worktrees')) throw new Error(`Refusing Git metadata/worktree path: ${file.path}`)
    // Paths have passed validateAgentOutput. Refuse symlinks at every component
    // so a write cannot escape through a pre-existing repository symlink.
    let cursor = worktree.path
    for (const segment of file.path.split('/')) {
      cursor = join(cursor, segment)
      const stat = await lstat(cursor).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      if (stat?.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${file.path}`)
    }
    const path = join(worktree.path, file.path)
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, file.content)
  }
  state = await verifyAndCommit(worktree, deps.company.project, deps.company.guardrails, state, deps.stateStore, message)
  await removeWorktree(worktree)
  return state
}
