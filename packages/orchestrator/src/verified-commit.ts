import type { ExecutionState, GuardrailsConfig, ProjectConfig, StateStore } from '@floor-agents/core'
import { commitWorktree, gitText, pushWorktree, type Worktree } from './worktree.ts'
import { runProjectCommand, validateWorktree, verifyWorktree } from './verification.ts'
import { recordGate } from './attempts.ts'

export function requireVerification(project: ProjectConfig): void {
  if (!project.root || !project.verification?.length) {
    throw new Error('Verified execution requires project.root and project.verification. Run floor-agents init or update your config.')
  }
}

export async function prepareWorkspace(worktree: Worktree, project: ProjectConfig): Promise<void> {
  for (const command of project.setup ?? []) {
    console.log(`[setup] ${command.name}`)
    const result = await runProjectCommand(worktree.path, command)
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`Setup failed: ${command.name} (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''})\n${result.stderr || result.stdout}`)
    }
  }
}

export async function resolveBaseSha(worktree: Worktree, project: ProjectConfig, state: ExecutionState): Promise<string> {
  if (state.baseSha) return state.baseSha
  if (!project.baseBranch) return worktree.initialSha
  await gitText(worktree.path, ['fetch', 'origin', `+refs/heads/${project.baseBranch}:refs/remotes/origin/${project.baseBranch}`])
  return gitText(worktree.path, ['merge-base', worktree.initialSha, `refs/remotes/origin/${project.baseBranch}`])
}

export async function verifyAndCommit(
  worktree: Worktree, project: ProjectConfig, guardrails: GuardrailsConfig,
  state: ExecutionState, store: StateStore, message: string,
): Promise<ExecutionState> {
  requireVerification(project)
  await validateWorktree(worktree, state.baseSha ?? worktree.initialSha, guardrails)
  const verification = await verifyWorktree(worktree, project.verification!, project.setup ?? [])
  // The gate run joins the attempt's history before anything can throw: a failed
  // gate is exactly the run a person will want to read afterwards.
  const checked = recordGate({ ...state, verification, updatedAt: new Date().toISOString() }, verification)
  await store.save(checked)
  if (!verification.passed) {
    const failure = verification.checks.find(c => c.exitCode !== 0 || c.timedOut)
    throw new Error(verification.error ?? `Verification failed: ${failure?.name} (exit ${failure?.exitCode}). Logs are in the execution state.`)
  }
  await validateWorktree(worktree, state.baseSha ?? worktree.initialSha, guardrails)
  const sha = await commitWorktree(worktree, message, verification.treeSha)
  if (!sha) throw new Error('Agent made no changes to the code')
  const committed = { ...checked, commitSha: sha, verification: { ...verification, commitSha: sha } }
  await store.save(committed)
  await pushWorktree(worktree, sha)
  return committed
}
