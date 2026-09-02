import { test, expect } from 'bun:test'
import {
  selectChecklistFiles,
  loadChecklists,
  NO_CHECKLIST_TEXT,
  type ChecklistRule,
} from '@floor-agents/orchestrator'
import type { FileContent } from '@floor-agents/core'

// ── selectChecklistFiles ────────────────────────────────────────────────

test('selects a rule matched by label (case-insensitive)', () => {
  const rules: ChecklistRule[] = [{ label: 'Auth', file: 'docs/review/concurrency.md' }]
  expect(selectChecklistFiles(rules, { labels: ['auth'], changedFiles: [] }))
    .toEqual(['docs/review/concurrency.md'])
  expect(selectChecklistFiles(rules, { labels: ['AUTH'], changedFiles: [] }))
    .toEqual(['docs/review/concurrency.md'])
})

test('selects a rule matched by a changed file whose path contains the pattern', () => {
  const rules: ChecklistRule[] = [{ pathContains: 'player/', file: 'docs/review/concurrency.md' }]
  expect(selectChecklistFiles(rules, { labels: [], changedFiles: ['player/Manager.kt'] }))
    .toEqual(['docs/review/concurrency.md'])
  expect(selectChecklistFiles(rules, { labels: [], changedFiles: ['other/File.kt'] }))
    .toEqual([])
})

test('pathContains matches mid-path, not just a leading prefix — real changed paths are nested under a lane directory', () => {
  const rules: ChecklistRule[] = [{ pathContains: 'player/', file: 'docs/review/concurrency.md' }]
  expect(selectChecklistFiles(rules, {
    labels: [],
    changedFiles: ['android/app/src/main/kotlin/com/radiooooo/android/player/PlayerManager.kt'],
  })).toEqual(['docs/review/concurrency.md'])
})

test('a rule with both label and pathContains matches on either condition alone', () => {
  const rules: ChecklistRule[] = [{ label: 'auth', pathContains: 'session', file: 'checklist.md' }]
  expect(selectChecklistFiles(rules, { labels: ['auth'], changedFiles: [] })).toEqual(['checklist.md'])
  expect(selectChecklistFiles(rules, { labels: [], changedFiles: ['session/store.ts'] })).toEqual(['checklist.md'])
  expect(selectChecklistFiles(rules, { labels: [], changedFiles: [] })).toEqual([])
})

test('a rule with neither label nor pathContains never matches (not treated as a wildcard)', () => {
  const rules: ChecklistRule[] = [{ file: 'checklist.md' } as ChecklistRule]
  expect(selectChecklistFiles(rules, { labels: ['auth'], changedFiles: ['player/x.kt'] })).toEqual([])
})

test('deduplicates by file path, keeping first-seen order across multiple matching rules', () => {
  const rules: ChecklistRule[] = [
    { label: 'auth', file: 'docs/review/concurrency.md' },
    { pathContains: 'player/', file: 'docs/review/concurrency.md' },
    { label: 'parity', file: 'docs/review/matrix.md' },
  ]
  const result = selectChecklistFiles(rules, {
    labels: ['auth', 'parity'],
    changedFiles: ['player/Manager.kt'],
  })
  expect(result).toEqual(['docs/review/concurrency.md', 'docs/review/matrix.md'])
})

test('no rules configured selects nothing', () => {
  expect(selectChecklistFiles([], { labels: ['auth'], changedFiles: ['player/x.kt'] })).toEqual([])
})

// ── loadChecklists ───────────────────────────────────────────────────────

function makeFileGetter(files: Record<string, FileContent>) {
  const calls: { repo: string; path: string; ref: string | undefined }[] = []
  return {
    calls,
    getFile: async (repo: string, path: string, ref?: string) => {
      calls.push({ repo, path, ref })
      return files[path] ?? null
    },
  }
}

test('returns NO_CHECKLIST_TEXT when no files are selected', async () => {
  const { getFile } = makeFileGetter({})
  const result = await loadChecklists({ getFile }, 'acme/widgets', 'deadbeef', [])
  expect(result).toBe(NO_CHECKLIST_TEXT)
})

test('fetches each file at the given ref and concatenates their content', async () => {
  const { getFile, calls } = makeFileGetter({
    'docs/review/concurrency.md': { path: 'docs/review/concurrency.md', content: '1. Check races.', encoding: 'utf-8' },
    'docs/review/matrix.md': { path: 'docs/review/matrix.md', content: '1. Check checkboxes.', encoding: 'utf-8' },
  })

  const result = await loadChecklists(
    { getFile },
    'acme/widgets',
    'deadbeefcafe',
    ['docs/review/concurrency.md', 'docs/review/matrix.md'],
  )

  expect(result).toContain('### docs/review/concurrency.md')
  expect(result).toContain('1. Check races.')
  expect(result).toContain('### docs/review/matrix.md')
  expect(result).toContain('1. Check checkboxes.')
  // Order preserved, and content fetched at the given ref (the PR's head
  // sha), not the target repo's default branch.
  expect(calls).toEqual([
    { repo: 'acme/widgets', path: 'docs/review/concurrency.md', ref: 'deadbeefcafe' },
    { repo: 'acme/widgets', path: 'docs/review/matrix.md', ref: 'deadbeefcafe' },
  ])
})

test('decodes base64-encoded file content', async () => {
  const encoded = Buffer.from('1. Check races.', 'utf-8').toString('base64')
  const { getFile } = makeFileGetter({
    'docs/review/concurrency.md': { path: 'docs/review/concurrency.md', content: encoded, encoding: 'base64' },
  })

  const result = await loadChecklists({ getFile }, 'acme/widgets', 'deadbeef', ['docs/review/concurrency.md'])
  expect(result).toContain('1. Check races.')
})

test('a missing checklist file at the given ref is skipped, logged, and does not throw', async () => {
  const { getFile } = makeFileGetter({
    'docs/review/matrix.md': { path: 'docs/review/matrix.md', content: 'present', encoding: 'utf-8' },
  })
  const logs: string[] = []

  const result = await loadChecklists(
    { getFile },
    'acme/widgets',
    'deadbeef',
    ['docs/review/renamed-away.md', 'docs/review/matrix.md'],
    line => logs.push(line),
  )

  expect(result).toContain('present')
  expect(result).not.toContain('renamed-away')
  expect(logs.some(l => l.includes('docs/review/renamed-away.md'))).toBe(true)
})

test('every selected file missing at the given ref falls back to NO_CHECKLIST_TEXT', async () => {
  const { getFile } = makeFileGetter({})
  const result = await loadChecklists({ getFile }, 'acme/widgets', 'deadbeef', ['docs/review/gone.md'])
  expect(result).toBe(NO_CHECKLIST_TEXT)
})
