import { test, expect, describe } from 'bun:test'
import type { VerificationResult } from '@floor-agents/core'
import { buildPrBody, issueReference, agentReport } from '../../packages/orchestrator/src/pr-body.ts'

const agent = { name: 'Grok', llm: { provider: 'cursor', model: 'cursor-grok-4.6-high', temperature: 0.2, maxTokens: 32000 } }
const verification: VerificationResult = {
  passed: true, treeSha: 'tree1', commitSha: 'commit1',
  checks: [{ name: 'Typecheck', command: ['bun', 'run', 'typecheck'], exitCode: 0, timedOut: false, durationMs: 10, stdout: '', stderr: '' }],
} as unknown as VerificationResult
const issue = { id: '198', title: 'docs: migration notes', body: 'The notes name an old API.', url: 'https://github.com/floor/vlist/issues/198' }
const state = { costUsd: 0, llmResponse: 'Replaced four stale API names.', parsedOutput: null, verification }

describe('agentReport', () => {
  // The shape a real cursor-agent run returned for floor/vlist#206: commentary
  // messages glued to the final report with no separator between them.
  const cursorResult = "I'll start by reading the migration notes.Next I’ll inspect the changelog and docs:check.The notes still name the old API. I’ll update those four lines.The 3.0 migration notes now name the grouped `PluginContext` API instead of the flat names that no longer exist.\n\n**`CHANGELOG.md`**\n- `registerMethod` → `ctx.hooks.method`\n\n`bun run docs:check` now reports no failures."

  test('keeps the final report and drops the narrated commentary', () => {
    const report = agentReport(cursorResult)
    expect(report.startsWith('The 3.0 migration notes now name')).toBe(true)
    expect(report).not.toContain("I'll start by reading")
    expect(report).toContain('`bun run docs:check` now reports no failures.')
  })

  test('leaves a single message untouched', () => {
    const claude = 'Replaced four names. Lines 132 and 134 stay: they describe the rename.'
    expect(agentReport(claude)).toBe(claude)
  })

  test('keeps the whole text when the last segment is only a closing remark', () => {
    const text = 'A long, real report describing every change made to the migration notes in detail, file by file and line by line.Done.'
    expect(agentReport(text)).toBe(text)
  })

  test('does not split inside file names or versions', () => {
    const text = 'Updated README.md and CHANGELOG.md for v3.0.0 so the notes match the grouped API names everywhere they appear in docs.'
    expect(agentReport(text)).toBe(text)
  })
})

describe('issueReference', () => {
  test('closes an issue in the same repository', () => {
    expect(issueReference(issue, 'vlist')).toBe('Closes #198')
  })

  test('refers to an issue in another repository by URL, never a bare #N', () => {
    expect(issueReference({ url: 'https://github.com/floor/docs/issues/7' }, 'vlist')).toBe('Refs https://github.com/floor/docs/issues/7')
  })

  test('has nothing to link for a task that is not a GitHub issue', () => {
    expect(issueReference({}, 'vlist')).toBeNull()
  })
})

describe('buildPrBody', () => {
  const body = buildPrBody({ issue, agent, state, repo: 'vlist', diffStat: ' CHANGELOG.md | 6 +++---\n 1 file changed' })

  test('leads with what changed, not with the task', () => {
    expect(body.indexOf('## Summary')).toBe(0)
    expect(body).toContain('Replaced four stale API names.')
    expect(body.indexOf('## Summary')).toBeLessThan(body.indexOf('<summary>Task:'))
  })

  test('marks the summary as the agent’s own account', () => {
    expect(body).toContain('The evidence is the diff and the engine verification below')
  })

  test('carries the diff stat, the verification and the issue link', () => {
    expect(body).toContain('CHANGELOG.md | 6 +++---')
    expect(body).toContain('**Engine verification: PASSED**')
    expect(body).toContain('Closes #198')
  })

  test('folds the original issue text under the evidence', () => {
    expect(body).toContain('<details>')
    expect(body).toContain('The notes name an old API.')
  })

  test('names the agent as a person reads it, and puts no price on a public page', () => {
    expect(body).toContain('**Agent:** Grok 4.6 high · implementer')
    expect(body).not.toContain('via cursor')
    expect(body).not.toContain('Cost')
    expect(body).not.toContain('$0.0000')
  })

  test('a task from a private tracker is referenced by its key and its text stays off the public PR', () => {
    const linear = { ...issue, url: 'https://linear.app/floor/issue/FLO-31/carousel-and-selection', key: 'FLO-31', body: 'private evidence: create.ts:546 …' }
    const body = buildPrBody({ issue: linear, agent, state, repo: 'vlist' })
    expect(body).toContain('Refs FLO-31')
    expect(body).toContain('**Task:** FLO-31 — docs: migration notes')
    expect(body).not.toContain('private evidence')
    expect(body).not.toContain('<details>')
  })

  test('prefers the agent-written PR description on the API path, and lists its files without a diff stat', () => {
    const api = buildPrBody({
      issue, agent, repo: 'vlist',
      state: { ...state, parsedOutput: { prDescription: 'API summary', files: [{ path: 'src/a.ts', content: 'x' }] } as never },
    })
    expect(api).toContain('API summary')
    expect(api).toContain('- `src/a.ts`')
  })

  test('says so when the agent reported nothing', () => {
    expect(buildPrBody({ issue, agent, repo: 'vlist', state: { ...state, llmResponse: null } })).toContain('_The agent reported no summary._')
  })

  test('trims a long report', () => {
    const long = buildPrBody({ issue, agent, repo: 'vlist', state: { ...state, llmResponse: 'x'.repeat(5000) } })
    expect(long).toContain('…')
    expect(long.length).toBeLessThan(3500)
  })
})
