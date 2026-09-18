import { afterEach, describe, expect, test } from 'bun:test'
import type { ExecutionState } from '@floor-agents/core'
import { closeInterrupted, engineStopping, LEFT_OPEN, liveChildren, resetLifecycle, stopChildren, trackChild } from '../../packages/orchestrator/src/lifecycle.ts'
import { freshState } from '../../packages/orchestrator/src/pipeline.ts'

afterEach(() => resetLifecycle())

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('stopping', () => {
  test.skipIf(process.platform === 'win32')('a stop ends the child and everything it started', async () => {
    // The shape of an agent CLI: a process that starts others. The grandchild prints its pid.
    const proc = Bun.spawn(['sh', '-c', 'sleep 60 & echo $!; wait'], { stdout: 'pipe', detached: true })
    trackChild(proc, proc.exited)
    const reader = proc.stdout.getReader()
    const grandchild = Number(new TextDecoder().decode((await reader.read()).value).trim())
    expect(alive(proc.pid)).toBe(true)
    expect(alive(grandchild)).toBe(true)
    expect(liveChildren()).toBe(1)

    expect(await stopChildren(100)).toBe(1)
    await proc.exited

    expect(engineStopping()).toBe(true)
    expect(alive(grandchild)).toBe(false)
    expect(liveChildren()).toBe(0)
  })

  test('a child that ends by itself is forgotten', async () => {
    const proc = Bun.spawn(['true'], { detached: process.platform !== 'win32' })
    trackChild(proc, proc.exited)
    await proc.exited
    await Bun.sleep(5)
    expect(liveChildren()).toBe(0)
    expect(engineStopping()).toBe(false)
  })
})

describe('a start after a crash', () => {
  const running = (over: Record<string, unknown> = {}): ExecutionState => ({
    ...freshState('issue', 'dev', {}), step: 'calling_llm',
    attempts: [{
      n: 3, kind: 'implement', agentId: 'dev', model: 'm', startedAt: '2026-09-18T21:00:00Z', baseSha: 'b', gates: [],
      outcome: 'running', worktreePath: '/repo/.agents/worktrees/agent-x-AbC', pid: 4242, ...over,
    }],
  })

  test('the turn left open is closed, and its agent ended if it is still the same process', async () => {
    const killed: number[] = []
    const { state, interrupted } = await closeInterrupted(running(), {
      commandOf: async () => 'sandbox-exec -p (allow file-write* (subpath "/repo/.agents/worktrees/agent-x-AbC")) cursor-agent -p …',
      kill: pid => { killed.push(pid) },
    })
    expect(killed).toEqual([4242])
    expect(interrupted).toEqual({ n: 3, killed: true, worktreePath: '/repo/.agents/worktrees/agent-x-AbC' })
    const attempt = state.attempts!.at(-1)!
    expect(attempt).toMatchObject({ outcome: 'stopped', error: LEFT_OPEN, worktreePath: '/repo/.agents/worktrees/agent-x-AbC' })
    expect(attempt.pid).toBeUndefined()
    // The step is untouched: the task goes on from where it was.
    expect(state.step).toBe('calling_llm')
  })

  test('a recycled pid is never touched', async () => {
    const killed: number[] = []
    const { interrupted } = await closeInterrupted(running(), { commandOf: async () => '/usr/bin/some-other-program', kill: pid => { killed.push(pid) } })
    expect(killed).toEqual([])
    expect(interrupted?.killed).toBe(false)
  })

  test('a process that is gone, or an attempt without a pid, is simply closed', async () => {
    const gone = await closeInterrupted(running(), { commandOf: async () => { throw new Error('no such process') }, kill: () => { throw new Error('must not') } })
    expect(gone.state.attempts!.at(-1)!.outcome).toBe('stopped')
    const noPid = await closeInterrupted(running({ pid: undefined }), { commandOf: async () => { throw new Error('must not look') }, kill: () => {} })
    expect(noPid.interrupted?.killed).toBe(false)
  })

  test('a state with nothing running is returned as it is', async () => {
    const closed = running({ outcome: 'published' })
    expect(await closeInterrupted(closed, { commandOf: async () => '', kill: () => {} })).toEqual({ state: closed })
  })
})
