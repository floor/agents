import { test, expect } from 'bun:test'
import { renderReviewPrompt } from '@floor-agents/codex-cli'

const TEMPLATE = [
  'repo: {{repo}}',
  'pr: {{prNumber}}',
  'sha: {{headSha}}',
  'title: {{title}}',
  'body: {{body}}',
  'base: {{baseRef}}',
  'files:',
  '{{changedFiles}}',
  '{{focusBlock}}',
].join('\n')

test('substitutes every placeholder', () => {
  const result = renderReviewPrompt(TEMPLATE, {
    repo: 'floor/agents',
    prNumber: 42,
    headSha: 'abc123',
    title: 'Add codex reviewer',
    body: 'Implements the Reviewer interface.',
    baseRef: 'main',
    changedFiles: ['packages/codex-cli/src/adapter.ts', 'packages/codex-cli/src/index.ts'],
  })

  expect(result).toContain('repo: floor/agents')
  expect(result).toContain('pr: 42')
  expect(result).toContain('sha: abc123')
  expect(result).toContain('title: Add codex reviewer')
  expect(result).toContain('body: Implements the Reviewer interface.')
  expect(result).toContain('base: main')
  expect(result).toContain('- packages/codex-cli/src/adapter.ts')
  expect(result).toContain('- packages/codex-cli/src/index.ts')
})

test('renders a placeholder for an empty changed-files list', () => {
  const result = renderReviewPrompt(TEMPLATE, {
    repo: 'floor/agents',
    prNumber: 1,
    headSha: 'sha',
    title: 't',
    body: 'b',
    baseRef: 'main',
    changedFiles: [],
  })

  expect(result).toContain('(no changed files listed)')
})

test('omits the focus block entirely when no focus is given', () => {
  const result = renderReviewPrompt(TEMPLATE, {
    repo: 'floor/agents',
    prNumber: 1,
    headSha: 'sha',
    title: 't',
    body: 'b',
    baseRef: 'main',
    changedFiles: [],
  })

  expect(result).not.toContain('## Focus')
})

test('includes a focus block when focus is given', () => {
  const result = renderReviewPrompt(TEMPLATE, {
    repo: 'floor/agents',
    prNumber: 1,
    headSha: 'sha',
    title: 't',
    body: 'b',
    baseRef: 'main',
    changedFiles: [],
    focus: 'Pay special attention to the timeout handling.',
  })

  expect(result).toContain('## Focus')
  expect(result).toContain('Pay special attention to the timeout handling.')
})

test('the real template file (prompts/review.md) round-trips through the renderer', async () => {
  const templatePath = new URL('../../packages/codex-cli/prompts/review.md', import.meta.url)
  const template = await Bun.file(templatePath).text()

  const result = renderReviewPrompt(template, {
    repo: 'floor/agents',
    prNumber: 7,
    headSha: 'deadbeef',
    title: 'Some PR',
    body: 'Some body',
    baseRef: 'main',
    changedFiles: ['a.ts'],
  })

  expect(result).not.toContain('{{')
  expect(result).toContain('## Reviewer agent (Codex)')
  expect(result).toContain('Verdict: approve as-is')
  expect(result).toContain('deadbeef')
})
