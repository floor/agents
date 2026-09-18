import { test, expect } from 'bun:test'
import { createAntigravityAdapter, buildAgyArgs, parseAgyResult, formatAgyTimeout } from '@floor-agents/antigravity'
import { reviewerSandbox, implementerSandbox } from '@floor-agents/sandbox'

test('creates adapter with a reviewer sandbox', () => {
  const adapter = createAntigravityAdapter({ sandbox: reviewerSandbox('antigravity', {}) })
  expect(typeof adapter.run).toBe('function')
})

test('creates adapter with custom config', () => {
  const adapter = createAntigravityAdapter({
    cwd: '/tmp',
    model: 'gemini-3.1-pro-high',
    role: 'implement',
    sandbox: implementerSandbox('antigravity', ['/tmp'], {}),
    timeoutMs: 60_000,
  })
  expect(typeof adapter.run).toBe('function')
})

// ── Arguments ───────────────────────────────────────────────────────
//
// A reviewer is read-only (`--mode plan`). An implementer auto-approves tools
// (`--dangerously-skip-permissions`) so it can edit and run tests. Neither flag
// is containment; the sandbox is.

test('runs headless with a machine-readable envelope and the engine timeout', () => {
  const args = buildAgyArgs({ prompt: 'hello', role: 'review', timeoutMs: 600_000, model: 'gemini-3.1-pro-high' })
  expect(args).toContain('-p')
  expect(args[args.indexOf('-p') + 1]).toBe('hello')
  expect(args[args.indexOf('--output-format') + 1]).toBe('json')
  expect(args[args.indexOf('--print-timeout') + 1]).toBe('10m')
  expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.1-pro-high')
})

test('a reviewer stays in plan mode; an implementer skips permission prompts', () => {
  const review = buildAgyArgs({ prompt: 'review this', role: 'review', timeoutMs: 60_000 })
  expect(review[review.indexOf('--mode') + 1]).toBe('plan')
  expect(review).not.toContain('--dangerously-skip-permissions')
  const impl = buildAgyArgs({ prompt: 'fix this', role: 'implement', timeoutMs: 60_000 })
  expect(impl).toContain('--dangerously-skip-permissions')
  expect(impl).not.toContain('--mode')
})

test('omits --model when none is configured, leaving the CLI default', () => {
  expect(buildAgyArgs({ prompt: 'x', role: 'review', timeoutMs: 1_000 })).not.toContain('--model')
})

test('passes --effort only when the caller names one', () => {
  expect(buildAgyArgs({ prompt: 'x', role: 'review', timeoutMs: 1_000 })).not.toContain('--effort')
  const args = buildAgyArgs({ prompt: 'x', role: 'review', timeoutMs: 1_000, effort: 'high' })
  expect(args[args.indexOf('--effort') + 1]).toBe('high')
})

test('formats the print timeout as a Go duration', () => {
  expect(formatAgyTimeout(600_000)).toBe('10m')
  expect(formatAgyTimeout(1_800_000)).toBe('30m')
  expect(formatAgyTimeout(45_000)).toBe('45s')
  expect(formatAgyTimeout(1_500)).toBe('1500ms')
  expect(formatAgyTimeout(0)).toBe('0s')
})

// ── Envelope ────────────────────────────────────────────────────────

const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    conversation_id: 'abc-123',
    status: 'SUCCESS',
    response: 'ok\n',
    duration_seconds: 15.2,
    num_turns: 1,
    usage: { input_tokens: 15548, output_tokens: 1121, thinking_tokens: 1120, cache_read_tokens: 0, total_tokens: 16669 },
    ...over,
  })

test('reads the result envelope', () => {
  const parsed = parseAgyResult(envelope())
  expect(parsed.response).toBe('ok\n')
  expect(parsed.status).toBe('SUCCESS')
  expect(parsed.conversationId).toBe('abc-123')
  expect(parsed.usage?.input_tokens).toBe(15548)
  expect(parsed.usage?.output_tokens).toBe(1121)
})

test('finds the envelope after progress output', () => {
  const parsed = parseAgyResult(`Thinking...\nRunning tool\n${envelope()}\n`)
  expect(parsed.response).toBe('ok\n')
  expect(parsed.status).toBe('SUCCESS')
})

test('skips trailing lines that only look like JSON', () => {
  const parsed = parseAgyResult(`${envelope()}\n{not valid json\n`)
  expect(parsed.response).toBe('ok\n')
})

test('throws when there is no envelope at all', () => {
  expect(() => parseAgyResult('command not found')).toThrow(/no JSON result/)
})

test('status ERROR is an error envelope, not a missing one', () => {
  const parsed = parseAgyResult(envelope({ status: 'ERROR', response: '', error: 'boom' }))
  expect(parsed.status).toBe('ERROR')
  expect(parsed.response).toBe('boom')
  expect(parsed.error).toBe('boom')
})

test.skipIf(!process.env.FLOOR_AGENTS_LIVE)('a live headless print returns SUCCESS', async () => {
  if (!Bun.which('agy')) throw new Error('agy not on PATH')
  const adapter = createAntigravityAdapter({
    model: 'gemini-3.8-flash-low',
    role: 'review',
    sandbox: reviewerSandbox('antigravity'),
    timeoutMs: 120_000,
  })
  const response = await adapter.run({
    provider: 'antigravity',
    model: 'gemini-3.8-flash-low',
    system: '',
    messages: [{ role: 'user', content: 'Reply with exactly the word ok.' }],
  })
  expect(response.content.toLowerCase()).toContain('ok')
  expect(response.usage.cost).toBe(0)
  expect(response.provider).toBe('antigravity')
})
