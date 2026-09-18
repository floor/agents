import { test, expect } from 'bun:test'
import { createClaudeCodeAdapter } from '@floor-agents/claude-code'
import {
  buildClaudeCodeArgs,
  formatClaudeCodeError,
  interpretClaudeCodeTurn,
} from '../../packages/claude-code/src/adapter.ts'
import { DEFAULT_MAX_TURNS } from '@floor-agents/orchestrator'

test('creates adapter with default config', () => {
  const adapter = createClaudeCodeAdapter()
  expect(typeof adapter.run).toBe('function')
})

test('creates adapter with custom config', () => {
  const adapter = createClaudeCodeAdapter({
    cwd: '/tmp',
    model: 'sonnet',
    maxTurns: 5,
    allowedTools: ['Read', 'Grep'],
  })
  expect(typeof adapter.run).toBe('function')
})

// ── Arguments ───────────────────────────────────────────────────────

test('the generic adapter default stays below the native review cap', () => {
  const args = buildClaudeCodeArgs({ prompt: 'p' })
  expect(args[0]).toBe('claude')
  expect(args).toContain('-p')
  expect(args[args.indexOf('--output-format') + 1]).toBe('json')
  expect(args[args.indexOf('--max-turns') + 1]).toBe('10')
  expect(Number(args[args.indexOf('--max-turns') + 1])).toBeLessThan(DEFAULT_MAX_TURNS.review)
})

test('a review-sized turn cap is passed to claude -p when the caller sets one', () => {
  const args = buildClaudeCodeArgs({ prompt: 'review the diff', maxTurns: DEFAULT_MAX_TURNS.review })
  expect(args[args.indexOf('-p') + 1]).toBe('review the diff')
  expect(args[args.indexOf('--max-turns') + 1]).toBe(String(DEFAULT_MAX_TURNS.review))
  expect(DEFAULT_MAX_TURNS.review).toBe(60)
})

test('a configured cap is passed through to claude -p', () => {
  const args = buildClaudeCodeArgs({ prompt: 'p', maxTurns: 5, model: 'sonnet', allowedTools: ['Read', 'Grep'] })
  expect(args[args.indexOf('--max-turns') + 1]).toBe('5')
  expect(args[args.indexOf('--model') + 1]).toBe('sonnet')
  expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Grep')
})

// ── Envelope ────────────────────────────────────────────────────────

test('an error carries subtype and the last 500 characters of stderr', () => {
  const stderr = `START${'n'.repeat(500)}trace-tail-unique`
  const message = formatClaudeCodeError(
    { subtype: 'error_during_execution', result: 'tool failed' },
    stderr,
  )
  expect(message).toBe(`Claude Code error (error_during_execution): tool failed\n${stderr.slice(-500)}`)
  expect(message).toContain('trace-tail-unique')
  expect(message).not.toContain('START')
})

test('an error without subtype still names the envelope', () => {
  const message = formatClaudeCodeError({ result: '' }, '')
  expect(message).toBe('Claude Code error: Unknown error')
  expect(() => interpretClaudeCodeTurn({ is_error: true }, 'logged-from-cli')).toThrow(
    'Claude Code error: Unknown error\nlogged-from-cli',
  )
})

test('a long result is truncated so the PR comment stays within GitHub limits', () => {
  const result = `prefix-${'x'.repeat(2500)}-tail-unique`
  const message = formatClaudeCodeError({ subtype: 'error_max_turns', result }, '')
  expect(message.startsWith('Claude Code error (error_max_turns): ')).toBe(true)
  expect(message).toContain('tail-unique')
  expect(message).not.toContain('prefix-')
  expect(message.length).toBeLessThanOrEqual('Claude Code error (error_max_turns): '.length + 2000)
})

test('error_max_turns with partial text still fails, including the text', () => {
  expect(() => interpretClaudeCodeTurn({
    is_error: true,
    subtype: 'error_max_turns',
    result: 'The empty case is untested.\nVOTE: APPROVE',
  }, 'turns exceeded')).toThrow(
    'Claude Code error (error_max_turns): The empty case is untested.\nVOTE: APPROVE\nturns exceeded',
  )
})

test('error_max_turns with no text still throws, including subtype', () => {
  expect(() => interpretClaudeCodeTurn({
    is_error: true,
    subtype: 'error_max_turns',
    result: '',
  }, 'ran out of turns')).toThrow('Claude Code error (error_max_turns): Unknown error\nran out of turns')
})

test('a successful envelope is returned as-is', () => {
  expect(interpretClaudeCodeTurn({ is_error: false, subtype: 'success', result: 'VOTE: APPROVE' }, '')).toBe('VOTE: APPROVE')
})
