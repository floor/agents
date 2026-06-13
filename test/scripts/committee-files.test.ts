import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { committeeFiles, safe, type PendingTask } from '../../scripts/lib/committee-files.ts'

const roots: string[] = []
function freshStore() {
  const base = mkdtempSync(join(tmpdir(), 'cf-'))
  roots.push(base)
  return committeeFiles(base)
}
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

const task = (id: string, over?: Partial<PendingTask>): PendingTask => ({
  id, title: `Title ${id}`, body: 'body', systemPrompt: 'be technical', ...over,
})

describe('safe', () => {
  test('replaces non [A-Za-z0-9._-] characters with _', () => {
    expect(safe('RFC-013:antigravity')).toBe('RFC-013_antigravity')
    expect(safe('a/b c:d')).toBe('a_b_c_d')
  })
  test('preserves allowed characters', () => {
    expect(safe('rfc-013_v1.2')).toBe('rfc-013_v1.2')
  })
})

describe('pending', () => {
  test('writePending returns the safe id and is readable back', () => {
    const f = freshStore()
    const sid = f.writePending(task('rfc:ag'))
    expect(sid).toBe('rfc_ag')
    expect(f.oldestPending()).toEqual(task('rfc:ag'))
  })

  test('oldestPending is null when empty', () => {
    expect(freshStore().oldestPending()).toBeNull()
  })

  test('oldestPending returns the oldest by mtime', () => {
    const f = freshStore()
    f.writePending(task('new'))
    f.writePending(task('old'))
    // make "old" genuinely older
    utimesSync(join(f.pending, 'old.json'), new Date(1000), new Date(1000))
    expect(f.oldestPending()!.id).toBe('old')
  })

  test('pendingSids lists all pending review ids', () => {
    const f = freshStore()
    f.writePending(task('a'))
    f.writePending(task('b'))
    expect(f.pendingSids().sort()).toEqual(['a', 'b'])
  })
})

describe('announce (dedup)', () => {
  test('announce returns true once, then false; isAnnounced tracks it', () => {
    const f = freshStore()
    f.writePending(task('x'))
    expect(f.isAnnounced('x')).toBe(false)
    expect(f.announce('x')).toBe(true)
    expect(f.isAnnounced('x')).toBe(true)
    expect(f.announce('x')).toBe(false)
  })
})

describe('results', () => {
  test('writeResult + readResult round-trips', () => {
    const f = freshStore()
    f.writeResult('rfc:ag', 'looks good\n\nVOTE: APPROVE')
    expect(f.resultFiles()).toEqual(['rfc_ag.json'])
    expect(f.readResult('rfc_ag.json')).toEqual({ taskId: 'rfc:ag', content: 'looks good\n\nVOTE: APPROVE' })
  })

  test('writeResult is atomic (no .tmp left behind)', () => {
    const f = freshStore()
    f.writeResult('t', 'x')
    expect(existsSync(join(f.results, 't.json.tmp'))).toBe(false)
    expect(existsSync(join(f.results, 't.json'))).toBe(true)
  })

  test('readResult returns null for non-json or missing', () => {
    const f = freshStore()
    expect(f.readResult('nope.txt')).toBeNull()
    expect(f.readResult('missing.json')).toBeNull()
  })
})

describe('clear', () => {
  test('removes pending, announced marker, and result', () => {
    const f = freshStore()
    f.writePending(task('z'))
    f.announce('z')
    f.writeResult('z', 'done')
    f.clear('z')
    expect(f.pendingSids()).toEqual([])
    expect(f.isAnnounced('z')).toBe(false)
    expect(f.resultFiles()).toEqual([])
  })
})
