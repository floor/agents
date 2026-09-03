import { test, expect } from 'bun:test'
import { selectPrepareCommands, type PrepareRule } from '@floor-agents/orchestrator'

test('a rule matches when a changed file starts with its pathPrefix', () => {
  const rules: PrepareRule[] = [{ pathPrefix: 'web/', command: 'bun install --frozen-lockfile' }]
  const selected = selectPrepareCommands(rules, ['web/src/app.ts', 'docs/readme.md'])
  expect(selected).toEqual([{ pathPrefix: 'web/', command: 'bun install --frozen-lockfile' }])
})

test('a rule does not match when no changed file starts with its pathPrefix', () => {
  const rules: PrepareRule[] = [{ pathPrefix: 'web/', command: 'bun install --frozen-lockfile' }]
  expect(selectPrepareCommands(rules, ['android/app/src/Main.kt'])).toEqual([])
})

test('matching is a plain prefix check, not "contains" — a path that merely mentions the prefix mid-string does not match', () => {
  const rules: PrepareRule[] = [{ pathPrefix: 'web/', command: 'bun install --frozen-lockfile' }]
  expect(selectPrepareCommands(rules, ['scripts/web/deploy.sh'])).toEqual([])
})

test('multiple rules can each match against different changed files in the same PR', () => {
  const rules: PrepareRule[] = [
    { pathPrefix: 'web/', command: 'bun install --frozen-lockfile' },
    { pathPrefix: 'android/', command: 'gradle dependencies' },
  ]
  const selected = selectPrepareCommands(rules, ['web/src/app.ts', 'android/app/src/Main.kt'])
  expect(selected).toEqual([
    { pathPrefix: 'web/', command: 'bun install --frozen-lockfile' },
    { pathPrefix: 'android/', command: 'gradle dependencies' },
  ])
})

test('the literal command "none" is an explicit no-op — never selected, regardless of matching changed files', () => {
  const rules: PrepareRule[] = [{ pathPrefix: 'ios/', command: 'none' }]
  expect(selectPrepareCommands(rules, ['ios/App/AppDelegate.swift'])).toEqual([])
})

test('"none" matching is case-insensitive and tolerates surrounding whitespace', () => {
  const rules: PrepareRule[] = [
    { pathPrefix: 'ios/', command: 'None' },
    { pathPrefix: 'android/', command: '  NONE  ' },
  ]
  expect(selectPrepareCommands(rules, ['ios/App/AppDelegate.swift', 'android/app/src/Main.kt'])).toEqual([])
})

test('an empty-string command is also treated as a no-op, same as "none"', () => {
  const rules: PrepareRule[] = [{ pathPrefix: 'ios/', command: '' }]
  expect(selectPrepareCommands(rules, ['ios/App/AppDelegate.swift'])).toEqual([])
})

test('a genuine command containing the substring "none" is NOT treated as a no-op — only an exact (trimmed, case-insensitive) match is', () => {
  const rules: PrepareRule[] = [{ pathPrefix: 'web/', command: 'echo none-of-this-matters && bun install' }]
  expect(selectPrepareCommands(rules, ['web/src/app.ts'])).toEqual([
    { pathPrefix: 'web/', command: 'echo none-of-this-matters && bun install' },
  ])
})

test('a duplicate pathPrefix later in the rules list is dropped, not re-selected', () => {
  const rules: PrepareRule[] = [
    { pathPrefix: 'web/', command: 'bun install --frozen-lockfile' },
    { pathPrefix: 'web/', command: 'npm ci' },
  ]
  const selected = selectPrepareCommands(rules, ['web/src/app.ts'])
  expect(selected).toEqual([{ pathPrefix: 'web/', command: 'bun install --frozen-lockfile' }])
})

test('no rules configured selects nothing', () => {
  expect(selectPrepareCommands([], ['web/src/app.ts'])).toEqual([])
})

test('no changed files selects nothing, even with rules configured', () => {
  const rules: PrepareRule[] = [{ pathPrefix: 'web/', command: 'bun install --frozen-lockfile' }]
  expect(selectPrepareCommands(rules, [])).toEqual([])
})
