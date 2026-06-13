import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { committeeFiles } from '../../scripts/lib/committee-files.ts'
import { formatPending, getPendingReviewText, submitVote } from '../../scripts/lib/mcp-tools.ts'

const roots: string[] = []
function freshStore() {
  const base = mkdtempSync(join(tmpdir(), 'mt-'))
  roots.push(base)
  return committeeFiles(base)
}
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

const task = { id: 'rfc:ag', title: 'RFC-013', body: 'the proposal', systemPrompt: 'browser-engine lens' }

describe('formatPending', () => {
  test('exposes taskId, title, persona, body, and submit instruction', () => {
    const text = formatPending(task)
    expect(text).toContain('taskId: rfc:ag')
    expect(text).toContain('title: RFC-013')
    expect(text).toContain('browser-engine lens')
    expect(text).toContain('the proposal')
    expect(text).toContain('submit_vote')
  })
})

describe('getPendingReviewText', () => {
  test('returns "No review pending." when empty', () => {
    expect(getPendingReviewText(freshStore())).toBe('No review pending.')
  })

  test('returns the formatted oldest pending review', () => {
    const f = freshStore()
    f.writePending(task)
    expect(getPendingReviewText(f)).toContain('taskId: rfc:ag')
  })
})

describe('submitVote', () => {
  test('writes a result the relay can read back by safe id', () => {
    const f = freshStore()
    submitVote(f, 'rfc:ag', 'ok\n\nVOTE: REJECT')
    expect(f.readResult('rfc_ag.json')).toEqual({ taskId: 'rfc:ag', content: 'ok\n\nVOTE: REJECT' })
  })
})
