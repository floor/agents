/**
 * The processes the engine has started, and the way to end them.
 *
 * It lives in core because every package that spawns something needs it: the
 * orchestrator (agent turns, project checks), the CLI adapters (reviewers), the
 * bridges. One registry per engine process.
 */

type Child = { readonly pid: number }

const children = new Set<Child>()
let stopping = false

/** Remember a child for as long as it runs. */
export function trackChild(child: Child, exited: Promise<unknown>): void {
  children.add(child)
  void exited.catch(() => {}).finally(() => children.delete(child))
}

export function liveChildren(): number {
  return children.size
}

/** True once a stop has begun: failures from here on are the stop's, not the work's. */
export function engineStopping(): boolean {
  return stopping
}

/**
 * Signal a child and everything it started. Children are spawned detached, as
 * leaders of their own process group: the negative pid reaches the CLI, its test
 * runners and its browsers. A child that is not a group leader gets the signal alone.
 */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal)
    else process.kill(pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch {}
  }
}

/**
 * Begin the stop: mark it, ask every child group to end, and make sure of it a
 * moment later. Safe to call twice. Returns how many children were running.
 */
export async function stopChildren(graceMs = 1_500): Promise<number> {
  stopping = true
  const pids = [...children].map(c => c.pid)
  for (const pid of pids) signalGroup(pid, 'SIGTERM')
  if (pids.length) {
    await new Promise(resolve => setTimeout(resolve, graceMs))
    for (const pid of pids) signalGroup(pid, 'SIGKILL')
  }
  return pids.length
}

/** For tests. */
export function resetLifecycle(): void {
  children.clear()
  stopping = false
}
