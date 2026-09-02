import { test, expect } from 'bun:test'
import { containsSandboxOverride, freezeExtraArgs } from '@floor-agents/codex-cli'

// Direct unit tests of the pure guard/copy helpers, covering every form the round-2
// and round-3 independent Codex reviews flagged as missed: the compact `-s<mode>`
// short form, the extended bypass-flag denylist, `-c`/`--config` setting
// `sandbox_mode`/`approval_policy`, `--add-dir`, and case-insensitivity — plus that
// the extraArgs copy is actually frozen, not just copied.

test('flags every form of the sandbox-select flag, including the compact short form', () => {
  expect(containsSandboxOverride(['-s', 'danger-full-access'])).toBe(true)
  expect(containsSandboxOverride(['-sdanger-full-access'])).toBe(true)
  expect(containsSandboxOverride(['-sworkspace-write'])).toBe(true)
  expect(containsSandboxOverride(['-s=danger-full-access'])).toBe(true)
  expect(containsSandboxOverride(['--sandbox', 'danger-full-access'])).toBe(true)
  expect(containsSandboxOverride(['--sandbox=danger-full-access'])).toBe(true)
})

test('is case-insensitive for the sandbox-select flag', () => {
  expect(containsSandboxOverride(['-S', 'danger-full-access'])).toBe(true)
  expect(containsSandboxOverride(['--SANDBOX=danger-full-access'])).toBe(true)
  expect(containsSandboxOverride(['-SDANGER-FULL-ACCESS'])).toBe(true)
})

test('flags every known bypass flag, case-insensitively', () => {
  for (const flag of [
    '--dangerously-bypass-approvals-and-sandbox',
    '--yolo',
    '--approve-for-me',
    '--not-so-yolo',
    '--full-auto',
  ]) {
    expect(containsSandboxOverride([flag])).toBe(true)
    expect(containsSandboxOverride([flag.toUpperCase()])).toBe(true)
  }
})

test('flags --add-dir in both bare and inline-value form', () => {
  expect(containsSandboxOverride(['--add-dir', '/etc'])).toBe(true)
  expect(containsSandboxOverride(['--add-dir=/etc'])).toBe(true)
  expect(containsSandboxOverride(['--ADD-DIR=/etc'])).toBe(true)
})

test('flags -c/--config setting sandbox_mode or approval_policy, in separate, compact, and inline forms', () => {
  expect(containsSandboxOverride(['-c', 'sandbox_mode=danger-full-access'])).toBe(true)
  expect(containsSandboxOverride(['-csandbox_mode=danger-full-access'])).toBe(true)
  expect(containsSandboxOverride(['--config', 'approval_policy=never'])).toBe(true)
  expect(containsSandboxOverride(['--config=approval_policy=never'])).toBe(true)
  expect(containsSandboxOverride(['-C', 'SANDBOX_MODE=danger-full-access'])).toBe(true)
})

test('does not flag an unrelated -c/--config value', () => {
  expect(containsSandboxOverride(['-c', 'model=gpt-5'])).toBe(false)
  expect(containsSandboxOverride(['--config', 'model_reasoning_effort=high'])).toBe(false)
  expect(containsSandboxOverride(['--config=model=gpt-5'])).toBe(false)
})

test('does not flag ordinary, unrelated extraArgs', () => {
  expect(containsSandboxOverride([])).toBe(false)
  expect(containsSandboxOverride(['--json'])).toBe(false)
  expect(containsSandboxOverride(['--color', 'never'])).toBe(false)
})

test('freezeExtraArgs returns a frozen copy, independent of the input array', () => {
  const original = ['--json']
  const frozen = freezeExtraArgs(original)

  expect(Object.isFrozen(frozen)).toBe(true)
  expect(frozen).toEqual(['--json'])
  expect(frozen).not.toBe(original)

  // Mutating the caller's original array must not affect the frozen copy.
  original.push('--sandbox=danger-full-access')
  expect(frozen).toEqual(['--json'])

  // And the frozen copy itself must reject mutation outright (strict-mode ESM).
  expect(() => {
    ;(frozen as string[]).push('x')
  }).toThrow(TypeError)
})

test('freezeExtraArgs defaults to an empty frozen array when no extraArgs is given', () => {
  const frozen = freezeExtraArgs(undefined)
  expect(Object.isFrozen(frozen)).toBe(true)
  expect(frozen).toEqual([])
})
