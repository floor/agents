import { test, expect } from 'bun:test'
import { buildReviewPrompt, extractChangedFiles, NO_CHECKLIST_TEXT, MERGE_BASE_UNRESOLVED_TEXT, type ReviewPromptContext } from '@floor-agents/orchestrator'

const BASE_CTX: ReviewPromptContext = {
  repo: 'acme/widgets',
  prNumber: '12',
  title: 'Add a feature',
  body: 'Does the thing.',
  baseRef: 'main',
  headRef: 'feat/thing',
  headSha: 'deadbeef',
  changedFiles: ['src/thing.ts'],
}

test('extractChangedFiles pulls post-change paths in first-seen order, deduplicated', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '+line',
    'diff --git a/src/b.ts b/src/b.ts',
    '+line',
    'diff --git a/src/a.ts b/src/a.ts',
    '+another line',
  ].join('\n')

  expect(extractChangedFiles(diff)).toEqual(['src/a.ts', 'src/b.ts'])
})

test('extractChangedFiles returns [] for an unparseable diff instead of throwing', () => {
  expect(extractChangedFiles('not a diff at all')).toEqual([])
})

test('buildReviewPrompt fills every known placeholder, including changedFiles as a bullet list', () => {
  const prompt = buildReviewPrompt(
    'Repo: {{repo}} #{{prNumber}} {{title}}\n{{body}}\n{{baseRef}}..{{headRef}} ({{headSha}})\n{{changedFiles}}',
    BASE_CTX,
  )
  expect(prompt).toBe(
    'Repo: acme/widgets #12 Add a feature\nDoes the thing.\nmain..feat/thing (deadbeef)\n- src/thing.ts',
  )
})

test('an unknown placeholder is left untouched rather than silently dropped', () => {
  expect(buildReviewPrompt('{{repo}} {{notAPlaceholder}}', BASE_CTX)).toBe('acme/widgets {{notAPlaceholder}}')
})

test('{{checklists}} renders the pre-built checklist text when provided', () => {
  const prompt = buildReviewPrompt('## Checklists\n\n{{checklists}}', {
    ...BASE_CTX,
    checklists: '### docs/review/concurrency.md\n\n1. Check races.',
  })
  expect(prompt).toBe('## Checklists\n\n### docs/review/concurrency.md\n\n1. Check races.')
})

test('{{checklists}} falls back to the "no checklist matched" line when ctx.checklists is unset', () => {
  const prompt = buildReviewPrompt('{{checklists}}', BASE_CTX)
  expect(prompt).toBe(NO_CHECKLIST_TEXT)
})

test('{{mergeBase}} renders the given merge-base sha when provided', () => {
  const prompt = buildReviewPrompt('git diff {{mergeBase}}...{{headSha}}', {
    ...BASE_CTX,
    mergeBase: 'cafef00d',
  })
  expect(prompt).toBe('git diff cafef00d...deadbeef')
})

test('{{mergeBase}} falls back to MERGE_BASE_UNRESOLVED_TEXT when ctx.mergeBase is unset', () => {
  const prompt = buildReviewPrompt('{{mergeBase}}', BASE_CTX)
  expect(prompt).toBe(MERGE_BASE_UNRESOLVED_TEXT)
})
