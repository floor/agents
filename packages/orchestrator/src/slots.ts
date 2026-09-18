/**
 * Machine slots: how many tasks run at once on this machine, across every
 * engine process on it.
 *
 * One `watch` process runs its tasks one after another, but a machine hosts one
 * process per project, plus whatever `run` a person starts by hand. Measured on
 * 2026-09-18: a third run at once stretched implementer turns from 12 to 18
 * minutes and tripped a browser assertion that passes alone (FLO-196). Until
 * now the limit was a habit of the coordinator.
 *
 * A slot is a loopback TCP port: slot n is `basePort + n`, and holding the slot
 * is listening on it. Binding is atomic, so two processes cannot both get it;
 * and the operating system gives the port back when its owner ends, however it
 * ends — there is nothing to clean up after a crash and nothing that can go
 * stale. (The first version used lock files. A test with real processes showed
 * two of them inside at once: creating the file and writing the owner's pid are
 * two steps, and a waiting process that looked in between took it for a slot
 * left behind.) A holder answers a connection with its pid, so a waiting task
 * can say who it is waiting for.
 */

import { engineStopping } from '@floor-agents/core'

export const DEFAULT_MAX_RUNS = 2
export const DEFAULT_SLOT_PORT = 47_600

export type SlotOptions = {
  /** Slot n listens on `basePort + n`. Every engine process on the machine must agree on it. */
  readonly basePort?: number
  readonly max?: number
  readonly pollMs?: number
  /** Told once when the task has to wait, with the pids holding the slots. */
  readonly onWait?: (holders: readonly number[]) => void
  readonly signal?: AbortSignal
}

export function slotSettings(env: Readonly<Record<string, string | undefined>> = process.env): { basePort: number; max: number } {
  const set = env.FLOOR_AGENTS_MAX_RUNS !== undefined && env.FLOOR_AGENTS_MAX_RUNS !== ''
  const max = Number(env.FLOOR_AGENTS_MAX_RUNS)
  const port = Number(env.FLOOR_AGENTS_SLOT_PORT)
  // A test run does not compete with an engine working on the same machine, unless it asks to.
  const fallback = env.NODE_ENV === 'test' ? 0 : DEFAULT_MAX_RUNS
  return {
    basePort: Number.isInteger(port) && port > 1023 && port < 65_000 ? port : DEFAULT_SLOT_PORT,
    // 0 turns the limit off; anything unreadable falls back to the default.
    max: set && Number.isInteger(max) && max >= 0 ? max : fallback,
  }
}

type Listener = { stop(closeActiveConnections?: boolean): void }

function tryListen(port: number): Listener | undefined {
  try {
    return Bun.listen({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socket.write(`${process.pid}\n`)
          socket.end()
        },
        data() {},
      },
    })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE' || /in use|EADDRINUSE/i.test(String(err))) return undefined
    throw err
  }
}

/** Who holds this slot, if it says. */
async function holderOf(port: number): Promise<number | undefined> {
  return new Promise(resolve => {
    let text = ''
    const timer = setTimeout(() => resolve(undefined), 500)
    const done = (): void => {
      clearTimeout(timer)
      const pid = Number(text.trim())
      resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined)
    }
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data(_socket, chunk) { text += new TextDecoder().decode(chunk) },
        close: done,
        error: done,
        connectError: done,
      },
    }).catch(done)
  })
}

/**
 * Take a slot, waiting for one if none is free. Returns the function that gives
 * it back. With `max` 0 there is no limit and nothing is opened.
 */
export async function acquireSlot(options: SlotOptions = {}): Promise<() => void> {
  const settings = slotSettings()
  const basePort = options.basePort ?? settings.basePort
  const max = options.max ?? settings.max
  if (max === 0) return () => {}

  let told = false
  while (true) {
    for (let n = 1; n <= max; n++) {
      const listener = tryListen(basePort + n)
      if (listener) {
        let released = false
        return () => {
          if (released) return
          released = true
          listener.stop(true)
        }
      }
    }
    if (!told) {
      told = true
      const holders = await Promise.all(Array.from({ length: max }, (_, i) => holderOf(basePort + i + 1)))
      options.onWait?.(holders.filter((pid): pid is number => pid !== undefined))
    }
    if (options.signal?.aborted || engineStopping()) throw new Error('Stopped while waiting for a machine slot')
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 5_000))
  }
}

/** Run one task inside a slot. The slot is given back whatever happens. */
export async function withSlot<T>(label: string, task: () => Promise<T>, options: SlotOptions = {}): Promise<T> {
  const release = await acquireSlot({
    onWait: holders => console.log(`[slots] ${label} waits for a machine slot${holders.length ? ` (held by pid ${holders.join(', ')})` : ''}`),
    ...options,
  })
  try {
    return await task()
  } finally {
    release()
  }
}
