import type { ExecutionState, GateRun, GuardrailsConfig, ProjectConfig, StateStore } from '@floor-agents/core'
import { commitWorktree, gitText, pushWorktree, type Worktree } from './worktree.ts'
import { runProjectCommand, validateWorktree, verifyWorktree, VerificationFailed } from './verification.ts'

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
  await gitText(worktree.path, ['fetch', 'origin', `refs/heads/${project.baseBranch}:refs/remotes/origin/${project.baseBranch}`])
  return gitText(worktree.path, ['merge-base', worktree.initialSha, `refs/remotes/origin/${project.baseBranch}`])
}

function toGateRun(verification: Awaited<ReturnType<typeof verifyWorktree>>): GateRun {
  return {
    startedAt: verification.checkedAt,
    durationMs: verification.durationMs ?? 0,
    passed: verification.passed,
    treeSha: verification.treeSha,
    checks: verification.checks,
    ...(verification.error ? { error: verification.error } : {}),
  }
}

export async function verifyAndCommit(
  worktree: Worktree, project: ProjectConfig, guardrails: GuardrailsConfig,
  state: ExecutionState, store: StateStore, message: string,
): Promise<ExecutionState> {
  requireVerification(project)
  await validateWorktree(worktree, state.baseSha ?? worktree.initialSha, guardrails)
  const verification = await verifyWorktree(worktree, project.verification!)
  const gateRuns = [...(state.gateRuns ?? []), toGateRun(verification)]
  const checked = { ...state, verification, gateRuns, updatedAt: new Date().toISOString() }
  await store.save(checked)
  if (!verification.passed) throw new VerificationFailed(verification, checked)
  await validateWorktree(worktree, state.baseSha ?? worktree.initialSha, guardrails)
  const sha = await commitWorktree(worktree, message, verification.treeSha)
  if (!sha) throw new Error('Agent made no changes to the code')
  const committed = { ...checked, commitSha: sha, verification: { ...verification, commitSha: sha } }
  await store.save(committed)
  await pushWorktree(worktree, sha)
  return committed
}
