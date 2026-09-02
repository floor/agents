import { test, expect } from 'bun:test'
import {
  selectChecklistFiles,
  loadChecklists,
  NO_CHECKLIST_TEXT,
  MAX_CHECKLIST_BYTES,
  MAX_TOTAL_CHECKLIST_BYTES,
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
    changedFiles: ['android/app/src/main/kotlin/com/example/app/player/PlayerManager.kt'],
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

// ── Size caps ────────────────────────────────────────────────────────────

test('a checklist file at or under MAX_CHECKLIST_BYTES is not truncated', async () => {
  const content = 'x'.repeat(MAX_CHECKLIST_BYTES)
  const { getFile } = makeFileGetter({
    'docs/review/big.md': { path: 'docs/review/big.md', content, encoding: 'utf-8' },
  })

  const result = await loadChecklists({ getFile }, 'acme/widgets', 'deadbeef', ['docs/review/big.md'])
  expect(result).not.toContain('truncated')
  expect(result).toContain(content)
})

test('a checklist file over MAX_CHECKLIST_BYTES is truncated to the cap with a visible marker, and logs it', async () => {
  const content = 'x'.repeat(MAX_CHECKLIST_BYTES + 1000)
  const { getFile } = makeFileGetter({
    'docs/review/big.md': { path: 'docs/review/big.md', content, encoding: 'utf-8' },
  })
  const logs: string[] = []

  const result = await loadChecklists(
    { getFile },
    'acme/widgets',
    'deadbeef',
    ['docs/review/big.md'],
    line => logs.push(line),
  )

  expect(result).toContain('truncated')
  expect(result).toContain(`${MAX_CHECKLIST_BYTES / 1024}KB`)
  // The body content itself (excluding the appended "\n\n[... marker) must
  // not exceed the per-file cap.
  const bodyOnly = result.split('\n\n[...')[0]!
  expect(Buffer.byteLength(bodyOnly, 'utf-8')).toBeLessThanOrEqual(MAX_CHECKLIST_BYTES + '### docs/review/big.md\n\n'.length)
  expect(logs.some(l => l.includes('truncated') && l.includes('docs/review/big.md'))).toBe(true)
})

test('checklists whose combined size is under MAX_TOTAL_CHECKLIST_BYTES are not truncated', async () => {
  const a = 'a'.repeat(1000)
  const b = 'b'.repeat(1000)
  const { getFile } = makeFileGetter({
    'docs/review/a.md': { path: 'docs/review/a.md', content: a, encoding: 'utf-8' },
    'docs/review/b.md': { path: 'docs/review/b.md', content: b, encoding: 'utf-8' },
  })

  const result = await loadChecklists({ getFile }, 'acme/widgets', 'deadbeef', ['docs/review/a.md', 'docs/review/b.md'])
  expect(result).toContain(a)
  expect(result).toContain(b)
  expect(result).not.toContain('total')
})

// Four files, each EXACTLY at MAX_CHECKLIST_BYTES (16384 bytes of raw
// content, so none is per-file-truncated on its own — this isolates the
// TOTAL cap's behavior from the per-file cap's). Each rendered section is
// header (24 bytes: "### docs/review/X.md\n\n") + content (16384 bytes) =
// 16408 bytes. Three of those (49224 bytes) already exceed the 48KB
// (49152 byte) total cap, so: a and b fit whole (32816 bytes used,
// 16336 remaining), c's own 16408-byte section doesn't fit in the 16336
// remaining and gets truncated to fit, and d is never fetched at all —
// the budget is exhausted before its turn.
function fourFilesAtCap() {
  const content = (ch: string) => ch.repeat(MAX_CHECKLIST_BYTES)
  return {
    'docs/review/a.md': { path: 'docs/review/a.md', content: content('a'), encoding: 'utf-8' as const },
    'docs/review/b.md': { path: 'docs/review/b.md', content: content('b'), encoding: 'utf-8' as const },
    'docs/review/c.md': { path: 'docs/review/c.md', content: content('c'), encoding: 'utf-8' as const },
    'docs/review/d.md': { path: 'docs/review/d.md', content: content('d'), encoding: 'utf-8' as const },
  }
}
const FOUR_FILES = ['docs/review/a.md', 'docs/review/b.md', 'docs/review/c.md', 'docs/review/d.md']

test('checklists whose combined size exceeds MAX_TOTAL_CHECKLIST_BYTES are truncated with a visible marker naming how many files were omitted', async () => {
  const { getFile } = makeFileGetter(fourFilesAtCap())
  const logs: string[] = []

  const result = await loadChecklists({ getFile }, 'acme/widgets', 'deadbeef', FOUR_FILES, line => logs.push(line))

  expect(result).toContain('docs/review/a.md')
  expect(result).toContain('a'.repeat(MAX_CHECKLIST_BYTES)) // a.md survives whole
  expect(result).toContain('b'.repeat(MAX_CHECKLIST_BYTES)) // b.md survives whole
  expect(result).toContain('c'.repeat(1000)) // c.md present, if truncated
  expect(result).not.toContain('d'.repeat(1000)) // d.md never included at all
  expect(result).toContain(`${MAX_TOTAL_CHECKLIST_BYTES / 1024}KB total`)
  expect(result).toContain('1 file(s) omitted entirely') // only d.md
  expect(logs.some(l => l.includes('total') && l.includes(String(MAX_TOTAL_CHECKLIST_BYTES)))).toBe(true)
})

test('the total cap stops fetching entirely once exhausted — the omitted file never triggers a getFile call', async () => {
  const { getFile, calls } = makeFileGetter(fourFilesAtCap())

  await loadChecklists({ getFile }, 'acme/widgets', 'deadbeef', FOUR_FILES)

  // a.md and b.md fetched whole; c.md fetched and then truncated to fit
  // the remaining budget; d.md never even requested since the budget was
  // already exhausted before its turn.
  expect(calls.map(c => c.path)).toEqual(['docs/review/a.md', 'docs/review/b.md', 'docs/review/c.md'])
})
