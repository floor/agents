import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { committeeFiles, type PendingTask } from '../../scripts/lib/committee-files.ts'
import { scanAndAnnounce, createNotifier } from '../../scripts/lib/notify.ts'

const roots: string[] = []
function freshStore() {
  const base = mkdtempSync(join(tmpdir(), 'nt-'))
  roots.push(base)
  return committeeFiles(base)
}
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

const task = (id: string): PendingTask => ({ id, title: id, body: 'b', systemPrompt: 's' })

describe('scanAndAnnounce', () => {
  test('emits each pending review exactly once across repeated scans', () => {
    const f = freshStore()
    f.writePending(task('a'))
    f.writePending(task('b'))

    const emitted: string[] = []
    scanAndAnnounce(f, (sid) => emitted.push(sid))
    expect(emitted.sort()).toEqual(['a', 'b'])

    // second scan: already announced → no re-emit (cycle-tolerant)
    scanAndAnnounce(f, (sid) => emitted.push(sid))
    expect(emitted.sort()).toEqual(['a', 'b'])
  })

  test('emits a newly-arrived review on a later scan', () => {
    const f = freshStore()
    f.writePending(task('first'))
    const emitted: string[] = []
    scanAndAnnounce(f, (sid) => emitted.push(sid))
    f.writePending(task('second'))
    scanAndAnnounce(f, (sid) => emitted.push(sid))
    expect(emitted).toEqual(['first', 'second'])
  })

  test('emits nothing when there are no pending reviews', () => {
    const emitted: string[] = []
    scanAndAnnounce(freshStore(), (sid) => emitted.push(sid))
    expect(emitted).toEqual([])
  })
})

describe('createNotifier', () => {
  test('announces reviews already pending at startup, and stop() is clean', () => {
    const f = freshStore()
    f.writePending(task('pre'))
    const emitted: string[] = []
    const n = createNotifier(f, (sid) => emitted.push(sid), 100_000)
    expect(emitted).toEqual(['pre'])
    n.stop()
  })
})
