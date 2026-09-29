import { describe, expect, test } from 'bun:test'
import { loadError, loadTasks, parseTask } from '../../benchmarks/verify.ts'

const valid = {
  id: 'demo',
  repo: 'floor/vlist',
  baseCommit: 'a'.repeat(40),
  referencePr: 1,
  referenceHead: 'b'.repeat(40),
  sizeClass: 'XS',
  changedSourceLines: 3,
  brief: 'Do the thing',
  testFiles: ['test/a.test.ts'],
  checks: ['bun test test/a.test.ts'],
}

describe('benchmark tasks', () => {
  test('every task file parses and is well formed', async () => {
    const tasks = await loadTasks()
    expect(tasks.length).toBeGreaterThanOrEqual(12)
    const repos = new Set(tasks.map(t => t.repo))
    expect(repos).toEqual(new Set(['floor/mtrl', 'floor/vlist']))
    for (const t of tasks) {
      expect(t.brief).not.toContain('TODO')
      expect(t.checks.some(c => t.testFiles.some(f => c.includes(f)))).toBe(true)
    }
  })

  test('ids are unique', async () => {
    const ids = (await loadTasks()).map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('parseTask', () => {
  test('accepts a complete task', () => {
    expect(parseTask(valid, 'demo.yaml').id).toBe('demo')
  })

  test('rejects a short sha, a bad size class and a mismatched file name', () => {
    expect(() => parseTask({ ...valid, baseCommit: 'abc' }, 'demo.yaml')).toThrow('full SHAs')
    expect(() => parseTask({ ...valid, sizeClass: 'L' }, 'demo.yaml')).toThrow('sizeClass')
    expect(() => parseTask(valid, 'other.yaml')).toThrow('does not match')
  })

  test('rejects empty lists', () => {
    expect(() => parseTask({ ...valid, checks: [] }, 'demo.yaml')).toThrow('checks')
  })
})

describe('loadError', () => {
  test('a missing module is a load error, an assertion failure is not', () => {
    expect(loadError("error: Cannot find module '../x' from 'y'")).toBeDefined()
    expect(loadError(" 3 pass\n 1 fail\n")).toBeUndefined()
  })
})
