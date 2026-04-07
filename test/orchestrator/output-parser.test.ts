import { test, expect } from 'bun:test'
import { parseToolCallOutput } from '@floor-agents/orchestrator'
import type { LLMResponse } from '@floor-agents/core'

function makeResponse(toolCalls: LLMResponse['toolCalls'], content = ''): LLMResponse {
  return {
    content,
    toolCalls,
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    provider: 'test',
    model: 'test',
    durationMs: 0,
  }
}

test('extracts files from write_file tool calls', () => {
  const output = parseToolCallOutput(makeResponse([
    { id: '1', name: 'write_file', input: { path: 'src/foo.ts', content: 'const x = 1' } },
    { id: '2', name: 'write_file', input: { path: 'src/bar.ts', content: 'const y = 2' } },
  ]))

  expect(output.files.length).toBe(2)
  expect(output.files[0]!.path).toBe('src/foo.ts')
  expect(output.files[1]!.content).toBe('const y = 2')
  expect(output.parseErrors).toEqual([])
})

test('extracts pr_description', () => {
  const output = parseToolCallOutput(makeResponse([
    { id: '1', name: 'write_file', input: { path: 'src/foo.ts', content: 'x' } },
    { id: '2', name: 'pr_description', input: { title: 'Add foo', description: 'This adds foo' } },
  ]))

  expect(output.prDescription).toBe('This adds foo')
})

test('reports error when no write_file calls', () => {
  const output = parseToolCallOutput(makeResponse([]))

  expect(output.files.length).toBe(0)
  expect(output.parseErrors.length).toBeGreaterThan(0)
})

test('handles missing path in write_file', () => {
  const output = parseToolCallOutput(makeResponse([
    { id: '1', name: 'write_file', input: { content: 'x' } },
  ]))

  expect(output.files.length).toBe(0)
  expect(output.parseErrors.length).toBeGreaterThan(0)
})

test('falls back to response content for pr description', () => {
  const output = parseToolCallOutput(makeResponse(
    [{ id: '1', name: 'write_file', input: { path: 'a.ts', content: 'x' } }],
    'Some explanation of changes',
  ))

  expect(output.prDescription).toBe('Some explanation of changes')
})
