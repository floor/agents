import { test, expect, describe } from 'bun:test'
import { buildCodexPrompt, buildCodexArgs } from '../../scripts/lib/codex.ts'

describe('buildCodexPrompt', () => {
  const task = { title: 'RFC-013', body: 'the proposal', systemPrompt: 'You are Codex.' }

  test('includes the persona, title, and body', () => {
    const p = buildCodexPrompt(task)
    expect(p).toContain('You are Codex.')
    expect(p).toContain('## Proposal: RFC-013')
    expect(p).toContain('the proposal')
  })

  test('instructs an explicit vote', () => {
    expect(buildCodexPrompt(task)).toContain('**VOTE: APPROVE** or **VOTE: REJECT**')
  })

  test('persona comes before the proposal', () => {
    const p = buildCodexPrompt(task)
    expect(p.indexOf('You are Codex.')).toBeLessThan(p.indexOf('## Proposal'))
  })
})

describe('buildCodexArgs', () => {
  test('runs exec read-only in the given cwd, writing the last message', () => {
    const args = buildCodexArgs({ cwd: '/repo', outFile: '/tmp/out.txt' })
    expect(args).toEqual([
      'exec', '--sandbox', 'read-only', '--cd', '/repo',
      '--skip-git-repo-check', '--output-last-message', '/tmp/out.txt', '-',
    ])
  })

  test('reads the prompt from stdin (trailing "-")', () => {
    expect(buildCodexArgs({ cwd: '/r', outFile: '/o' }).at(-1)).toBe('-')
  })

  test('adds --model only when provided, before the stdin marker', () => {
    const args = buildCodexArgs({ cwd: '/r', outFile: '/o', model: 'o3' })
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('o3')
    expect(args.at(-1)).toBe('-')
    expect(buildCodexArgs({ cwd: '/r', outFile: '/o' })).not.toContain('--model')
  })
})
