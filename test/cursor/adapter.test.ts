import { test, expect } from 'bun:test'
import { createCursorAdapter, buildCursorArgs, parseCursorResult } from '@floor-agents/cursor'
import { reviewerSandbox, implementerSandbox } from '@floor-agents/sandbox'

test('creates adapter with a reviewer sandbox', () => {
  const adapter = createCursorAdapter({ sandbox: reviewerSandbox('cursor', {}) })
  expect(typeof adapter.run).toBe('function')
})

test('creates adapter with custom config', () => {
  const adapter = createCursorAdapter({
    cwd: '/tmp',
    model: 'cursor-grok-4.6-high',
    allowShell: true,
    sandbox: implementerSandbox('cursor', ['/tmp'], {}),
    timeoutMs: 60_000,
  })
  expect(typeof adapter.run).toBe('function')
})

// ── Arguments ───────────────────────────────────────────────────────
//
// The CLI refuses to start in an untrusted directory, so exactly one consent
// flag is always present. Measured: `--trust` still lets the edit tool write
// anywhere, and only refuses shell commands. Neither flag is containment.

test('runs headless with a machine-readable envelope', () => {
  const args = buildCursorArgs({ prompt: 'hello' })
  expect(args).toContain('-p')
  expect(args[args.indexOf('-p') + 1]).toBe('hello')
  expect(args[args.indexOf('--output-format') + 1]).toBe('json')
})

test('refuses shell commands by default', () => {
  const args = buildCursorArgs({ prompt: 'review this' })
  expect(args).toContain('--trust')
  expect(args).not.toContain('--force')
})

test('approves shell commands only when allowShell is set', () => {
  const args = buildCursorArgs({ prompt: 'fix this', allowShell: true })
  expect(args).toContain('--force')
  expect(args).not.toContain('--trust')
})

test('passes the model identifier through verbatim', () => {
  // Effort is part of the identifier, not a separate flag.
  const args = buildCursorArgs({ prompt: 'x', model: 'cursor-grok-4.6-xhigh' })
  expect(args[args.indexOf('--model') + 1]).toBe('cursor-grok-4.6-xhigh')
})

test('omits --model when none is configured, leaving the CLI default', () => {
  expect(buildCursorArgs({ prompt: 'x' })).not.toContain('--model')
})

// ── Envelope ────────────────────────────────────────────────────────

const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 3644,
    result: 'READY',
    session_id: '4c1f75d9',
    usage: { inputTokens: 9506, outputTokens: 25 },
    ...over,
  })

test('reads the result envelope', () => {
  const parsed = parseCursorResult(envelope())
  expect(parsed.result).toBe('READY')
  expect(parsed.is_error).toBe(false)
  expect(parsed.usage?.inputTokens).toBe(9506)
})

test('finds the envelope after progress output', () => {
  // The CLI prints progress before the result, so the JSON is the last line,
  // not the whole of stdout.
  const parsed = parseCursorResult(`Thinking...\nRunning tool\n${envelope()}\n`)
  expect(parsed.result).toBe('READY')
})

test('skips trailing lines that only look like JSON', () => {
  const parsed = parseCursorResult(`${envelope()}\n{not valid json\n`)
  expect(parsed.result).toBe('READY')
})

test('throws when there is no envelope at all', () => {
  expect(() => parseCursorResult('command not found')).toThrow(/no JSON result/)
})
