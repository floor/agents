/**
 * Stopping and starting again.
 *
 * The engine starts processes that outlive a careless exit: an agent CLI in its
 * own process group, the project's checks, the reviewers' bridges. A `SIGTERM`
 * used to end the engine and leave them running — an agent still editing a
 * worktree nobody would read — and the next start resumed the same issue with a
 * second agent beside the first (FLO-182). A service is restarted routinely, so:
 *
 * - every child is tracked, and a stop ends its whole process group;
 * - a turn cut short by a stop is recorded as stopped by the engine — not as the
 *   agent's failure, with no report on the issue and no `needs-human`;
 * - the next start closes whatever a crash left open and, if the agent of that
 *   turn is somehow still alive, ends it before starting another.
 */

import type { ExecutionState } from '@floor-agents/core'
import { signalGroup } from '@floor-agents/core'
import { closeAttempt, lastAttempt } from './attempts.ts'

// The registry of children is in core, where the CLI adapters can reach it too.
export { trackChild, liveChildren, engineStopping, stopChildren, resetLifecycle } from '@floor-agents/core'

export const STOPPED_BY_ENGINE = 'The engine was stopped during this turn; the turn did not fail. It starts again when the engine does.'
export const LEFT_OPEN = 'The engine ended without closing this turn (a crash or a kill); its tree was kept.'

/**
 * What a start does with a state whose last attempt is still marked running:
 * nothing is running it any more, or should be.
 *
 * `alive` and `kill` look at the process recorded on the attempt. It is ended
 * only if it still carries the attempt's worktree in its command line — the
 * sandbox profile names it — so a recycled pid is never touched.
 */
export async function closeInterrupted(
  state: ExecutionState,
  deps: {
    readonly commandOf: (pid: number) => Promise<string>
    readonly kill: (pid: number) => void
  },
): Promise<{ readonly state: ExecutionState; readonly interrupted?: { readonly n: number; readonly killed: boolean; readonly worktreePath?: string } }> {
  const attempt = lastAttempt(state)
  if (!attempt || attempt.outcome !== 'running') return { state }
  let killed = false
  if (attempt.pid && attempt.worktreePath) {
    const command = await deps.commandOf(attempt.pid).catch(() => '')
    if (command.includes(attempt.worktreePath)) {
      deps.kill(attempt.pid)
      killed = true
    }
  }
  return {
    state: closeAttempt(state, 'stopped', { error: LEFT_OPEN }),
    interrupted: { n: attempt.n, killed, ...(attempt.worktreePath ? { worktreePath: attempt.worktreePath } : {}) },
  }
}

/** The process table, for {@link closeInterrupted}. */
export const processTable = {
  async commandOf(pid: number): Promise<string> {
    const proc = Bun.spawn(['ps', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return text.trim()
  },
  kill(pid: number): void {
    signalGroup(pid, 'SIGKILL')
  },
}
