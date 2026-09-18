import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSlot, DEFAULT_MAX_RUNS, DEFAULT_SLOT_PORT, slotSettings, withSlot } from '../../packages/orchestrator/src/slots.ts'

let dir = ''
let basePort = 0
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slots-'))
  // A range of its own per test: tests never meet each other, or an engine at work.
  basePort = 50_000 + Math.floor(Math.random() * 9_000)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('machine slots', () => {
  test('two fit, the third waits until one is given back, and says who it waits for', async () => {
    const opts = { basePort, max: 2, pollMs: 5 }
    const first = await acquireSlot(opts)
    const second = await acquireSlot(opts)

    let waitedFor: readonly number[] = []
    let third: (() => void) | undefined
    const pending = acquireSlot({ ...opts, onWait: holders => { waitedFor = holders } }).then(r => { third = r })
    await Bun.sleep(60)
    expect(third).toBeUndefined()
    expect(waitedFor).toEqual([process.pid, process.pid])

    first()
    await pending
    expect(third).toBeDefined()
    second()
    third!()
    // All given back: two can be taken again at once.
    const again = await Promise.all([acquireSlot(opts), acquireSlot(opts)])
    again.forEach(release => release())
  })

  test('withSlot gives the slot back when the task throws', async () => {
    await expect(withSlot('FLO-1', async () => { throw new Error('boom') }, { basePort, max: 1, pollMs: 5 })).rejects.toThrow('boom')
    expect(await withSlot('FLO-2', async () => 'ok', { basePort, max: 1, pollMs: 5 })).toBe('ok')
  })

  test('giving back twice is harmless', async () => {
    const release = await acquireSlot({ basePort, max: 1, pollMs: 5 })
    release()
    release()
    const next = await acquireSlot({ basePort, max: 1, pollMs: 5 })
    next()
  })

  test('max 0 is no limit, and nothing is opened', async () => {
    const hold = await acquireSlot({ basePort, max: 1, pollMs: 5 })
    const free = await acquireSlot({ basePort, max: 0 })
    free()
    hold()
  })

  test('a waiting task gives up when asked to', async () => {
    const hold = await acquireSlot({ basePort, max: 1, pollMs: 5 })
    const stop = new AbortController()
    const waiting = acquireSlot({ basePort, max: 1, pollMs: 5, signal: stop.signal })
    stop.abort()
    await expect(waiting).rejects.toThrow('waiting for a machine slot')
    hold()
  })

  const worker = (body: string): string => `
    import { appendFile } from 'node:fs/promises'
    import { withSlot } from '${join(import.meta.dir, '../../packages/orchestrator/src/slots.ts')}'
    const log = (line: string) => appendFile('${join(dir, 'log.txt')}', line + '\\n')
    await withSlot(process.argv[2]!, async () => { ${body} }, { basePort: Number(process.argv[3]), max: 1, pollMs: 10 })
  `

  test('real processes contend for one slot and never overlap', async () => {
    const script = join(dir, 'worker.ts')
    await writeFile(script, worker(`await log('in ' + process.argv[2]); await Bun.sleep(120); await log('out ' + process.argv[2])`))
    const workers = ['a', 'b', 'c', 'd'].map(name => Bun.spawn(['bun', script, name, String(basePort)], { stdout: 'ignore', stderr: 'inherit' }))
    expect(await Promise.all(workers.map(w => w.exited))).toEqual([0, 0, 0, 0])
    const lines = (await readFile(join(dir, 'log.txt'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(8)
    // Strictly in/out/in/out: nobody entered while another was inside.
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i]!.startsWith('in ')).toBe(true)
      expect(lines[i + 1]).toBe(`out ${lines[i]!.slice(3)}`)
    }
  }, 30_000)

  test('a holder that is killed gives its slot back: a crash does not shrink the machine', async () => {
    const script = join(dir, 'holder.ts')
    await writeFile(script, worker(`await log('holding'); await Bun.sleep(60_000)`))
    const holder = Bun.spawn(['bun', script, 'crasher', String(basePort)], { stdout: 'ignore', stderr: 'inherit' })
    for (let i = 0; i < 200; i++) {
      if ((await readFile(join(dir, 'log.txt'), 'utf8').catch(() => '')).includes('holding')) break
      await Bun.sleep(25)
    }
    let waited = false
    const pending = acquireSlot({ basePort, max: 1, pollMs: 10, onWait: () => { waited = true } })
    await Bun.sleep(60)
    expect(waited).toBe(true)
    holder.kill('SIGKILL')
    const release = await pending
    release()
  }, 30_000)
})

describe('slot settings', () => {
  test('two by default; the environment sets the limit and the port range', () => {
    expect(slotSettings({})).toEqual({ basePort: DEFAULT_SLOT_PORT, max: DEFAULT_MAX_RUNS })
    expect(slotSettings({ FLOOR_AGENTS_MAX_RUNS: '3', FLOOR_AGENTS_SLOT_PORT: '48000' })).toEqual({ basePort: 48_000, max: 3 })
    expect(slotSettings({ FLOOR_AGENTS_MAX_RUNS: '0' }).max).toBe(0)
    expect(slotSettings({ FLOOR_AGENTS_MAX_RUNS: 'many', FLOOR_AGENTS_SLOT_PORT: '80' })).toEqual({ basePort: DEFAULT_SLOT_PORT, max: DEFAULT_MAX_RUNS })
  })

  test('a test run has no limit unless it asks for one: tests do not compete with an engine at work', () => {
    expect(slotSettings({ NODE_ENV: 'test' }).max).toBe(0)
    expect(slotSettings({ NODE_ENV: 'test', FLOOR_AGENTS_MAX_RUNS: '1' }).max).toBe(1)
  })
})
