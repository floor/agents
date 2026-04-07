import { test, expect } from 'bun:test'
import { validateAgentOutput } from '@floor-agents/orchestrator'
import type { AgentOutput, GuardrailsConfig } from '@floor-agents/core'

const defaults: GuardrailsConfig = {
  maxFilesPerTask: 3,
  maxFileSizeBytes: 1024,
  maxTotalOutputBytes: 2048,
  blockedPaths: ['.env*', '*.key'],
  allowedPaths: [],
  blockedExtensions: ['.exe', '.bin'],
}

function makeOutput(files: { path: string; content: string }[]): AgentOutput {
  return {
    rawResponse: '',
    files,
    prDescription: '',
    parseErrors: [],
  }
}

test('passes valid output', () => {
  const violations = validateAgentOutput(
    makeOutput([{ path: 'src/foo.ts', content: 'const x = 1' }]),
    defaults,
  )
  expect(violations).toEqual([])
})

test('detects too many files', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({
    path: `src/file${i}.ts`,
    content: 'x',
  }))
  const violations = validateAgentOutput(makeOutput(files), defaults)
  expect(violations.some(v => v.type === 'too_many_files')).toBe(true)
})

test('detects file too large', () => {
  const violations = validateAgentOutput(
    makeOutput([{ path: 'big.ts', content: 'x'.repeat(2000) }]),
    defaults,
  )
  expect(violations.some(v => v.type === 'file_too_large')).toBe(true)
})

test('detects blocked path', () => {
  const violations = validateAgentOutput(
    makeOutput([{ path: '.env.local', content: 'SECRET=x' }]),
    defaults,
  )
  expect(violations.some(v => v.type === 'blocked_path')).toBe(true)
})

test('detects blocked extension', () => {
  const violations = validateAgentOutput(
    makeOutput([{ path: 'malware.exe', content: 'bad' }]),
    defaults,
  )
  expect(violations.some(v => v.type === 'blocked_extension')).toBe(true)
})

test('detects path traversal', () => {
  const violations = validateAgentOutput(
    makeOutput([{ path: '../../../etc/passwd', content: 'x' }]),
    defaults,
  )
  expect(violations.some(v => v.type === 'path_traversal')).toBe(true)
})

test('detects absolute path', () => {
  const violations = validateAgentOutput(
    makeOutput([{ path: '/etc/passwd', content: 'x' }]),
    defaults,
  )
  expect(violations.some(v => v.type === 'path_traversal')).toBe(true)
})

test('enforces allowed paths', () => {
  const config = { ...defaults, allowedPaths: ['src/**'] }
  const violations = validateAgentOutput(
    makeOutput([{ path: 'lib/foo.ts', content: 'x' }]),
    config,
  )
  expect(violations.some(v => v.type === 'outside_allowed_paths')).toBe(true)
})
