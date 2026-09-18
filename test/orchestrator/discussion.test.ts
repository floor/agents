import { describe, expect, test } from 'bun:test'
import type { AgentDefinition, GitAdapter, Issue, IssueComment, ProjectConfig, TaskAdapter } from '@floor-agents/core'
import { createContextBuilder } from '@floor-agents/context-builder'
import { discussionSection } from '../../packages/orchestrator/src/discussion.ts'
import { agentSignature, sign, ENGINE_SIGNATURE } from '../../packages/orchestrator/src/comment-signature.ts'

const grok = { name: 'Grok', llm: { model: 'cursor-grok-4.6-high', provider: 'cursor' } } as never

function comment(overrides: Partial<IssueComment> & Pick<IssueComment, 'body' | 'createdAt'>): IssueComment {
  return {
    id: overrides.id ?? overrides.createdAt.toISOString(),
    author: overrides.author ?? 'alice',
    createdAt: overrides.createdAt,
    body: overrides.body,
  }
}

describe('discussionSection', () => {
  test('nothing to read is omitted from the prompt', () => {
    expect(discussionSection([])).toBe('')
  })

  test('drops implementer, reviewer and committee signatures; keeps people and the engine', () => {
    const comments = [
      comment({ author: 'jvial', body: 'start from the tests', createdAt: new Date('2026-09-16T00:00:00Z') }),
      comment({ author: 'bot', body: sign('working on the code...', agentSignature(grok, 'implementer')), createdAt: new Date('2026-09-17T00:00:00Z') }),
      comment({ author: 'bot', body: sign('looks good', agentSignature(grok, 'reviewer')), createdAt: new Date('2026-09-17T12:00:00Z') }),
      comment({ author: 'bot', body: sign('voted approve', agentSignature(grok, 'committee member')), createdAt: new Date('2026-09-17T13:00:00Z') }),
      comment({ author: 'bot', body: sign('⏱ **Grok** stopped: cap of 25 tool calls', ENGINE_SIGNATURE), createdAt: new Date('2026-09-18T00:00:00Z') }),
    ]
    const section = discussionSection(comments)
    expect(section.startsWith('## Discussion\n')).toBe(true)
    expect(section).toContain('**jvial** (2026-09-16):\nstart from the tests')
    expect(section).toContain('stopped: cap of 25 tool calls')
    expect(section).toContain('**Agent:** Floor Agents · engine')
    expect(section).not.toContain('working on the code')
    expect(section).not.toContain('looks good')
    expect(section).not.toContain('voted approve')
    expect(section).not.toContain('· implementer')
    expect(section).not.toContain('· reviewer')
    expect(section).not.toContain('· committee member')
  })

  test('keeps an unsigned comment even when it mentions an agent role', () => {
    const section = discussionSection([
      comment({ author: 'jvial', body: 'the implementer should retry from HEAD', createdAt: new Date('2026-09-18T00:00:00Z') }),
    ])
    expect(section).toContain('the implementer should retry from HEAD')
  })

  test('renders oldest first even when the adapter returns newest first', () => {
    const section = discussionSection([
      comment({ author: 'bob', body: 'second', createdAt: new Date('2026-09-18T12:00:00Z') }),
      comment({ author: 'alice', body: 'first', createdAt: new Date('2026-09-17T12:00:00Z') }),
    ])
    expect(section.indexOf('first')).toBeLessThan(section.indexOf('second'))
    expect(section).toContain('**alice** (2026-09-17):')
    expect(section).toContain('**bob** (2026-09-18):')
  })

  test('keeps the most recent 20 and notes how many earlier comments were omitted', () => {
    const comments = Array.from({ length: 25 }, (_, i) => comment({
      author: 'p',
      body: `msg-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    }))
    const section = discussionSection(comments)
    expect(section).toContain('(5 earlier comments omitted)')
    expect(section).not.toContain('msg-0')
    expect(section).not.toContain('msg-4')
    expect(section).toContain('msg-5')
    expect(section).toContain('msg-24')
    expect(section.indexOf('msg-5')).toBeLessThan(section.indexOf('msg-24'))
  })

  test('drops the oldest kept comments to fit 16,000 characters, newest first in priority', () => {
    const comments = Array.from({ length: 6 }, (_, i) =>
      comment({ author: `u${i}`, body: `${i}:` + 'x'.repeat(3_500), createdAt: new Date(Date.UTC(2026, 8, 10 + i)) }))
    const section = discussionSection(comments)
    expect(section.length).toBeLessThanOrEqual(16_000)
    expect(section).toContain('**u5**')
    expect(section).not.toContain('**u0**')
    expect(section).toContain('earlier comments omitted')
  })

  test('one oversized comment is shortened, not dropped — it used to erase the whole discussion', () => {
    // A coordinator hint carrying a 47,000-character diff (vlist FLO-163).
    const hint = 'Hint: start from the preserved tree.\n' + 'd'.repeat(47_000) + '\nLeave package.json untouched.'
    const section = discussionSection([comment({ author: 'coordinator', body: hint, createdAt: new Date('2026-09-18T10:00:00Z') })])
    expect(section).toContain('Hint: start from the preserved tree.')
    expect(section).toContain('Leave package.json untouched.')
    expect(section).toMatch(/\(\d+ characters omitted — the full comment is on the issue\)/)
    expect(section.length).toBeLessThan(5_000)
  })

  test('an old oversized comment and a new short one: the short one is intact', () => {
    const section = discussionSection([
      comment({ author: 'earlier', body: 'o'.repeat(50_000), createdAt: new Date('2026-09-17T00:00:00Z') }),
      comment({ author: 'later', body: 'Use nav.reveal, not nav.navigate.', createdAt: new Date('2026-09-18T00:00:00Z') }),
    ])
    expect(section).toContain('Use nav.reveal, not nav.navigate.')
    expect(section).toContain('**earlier**')
    expect(section.indexOf('**earlier**')).toBeLessThan(section.indexOf('**later**'))
  })

  test('a discussion that exists never reads as empty, whatever its size', () => {
    const section = discussionSection(Array.from({ length: 30 }, (_, i) =>
      comment({ author: `u${i}`, body: 'y'.repeat(60_000), createdAt: new Date(Date.UTC(2026, 8, 1, i)) })))
    expect(section).toContain('## Discussion')
    expect(section).toContain('**u29**')
    expect(section.length).toBeLessThanOrEqual(16_000)
  })

  test('progress comments do not count toward the cap or the omitted line', () => {
    const progress = Array.from({ length: 10 }, (_, i) => comment({
      author: 'bot',
      body: sign(`progress ${i}`, agentSignature(grok, 'implementer')),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    }))
    const kept = comment({ author: 'jvial', body: 'the hint', createdAt: new Date(Date.UTC(2026, 0, 1, 1, 0)) })
    const section = discussionSection([...progress, kept])
    expect(section).toContain('the hint')
    expect(section).not.toContain('earlier comments omitted')
    expect(section).not.toContain('progress 0')
  })
})

describe('API context discussion', () => {
  const issue: Issue = {
    id: '1',
    title: 'Fix the answer',
    body: 'Correct answer.txt',
    status: 'backlog',
    labels: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  const project: ProjectConfig = {
    name: 'test-repo',
    repo: 'org/repo',
    language: 'typescript',
    runtime: 'bun',
    structure: {},
    conventions: {},
    packages: [],
    customInstructions: '',
  }
  const agent: AgentDefinition = {
    id: 'backend',
    name: 'Backend',
    promptTemplate: '',
    llm: { provider: 'anthropic', model: 'test', temperature: 0, maxTokens: 100 },
    capabilities: ['write_code'],
    autonomy: 'T1',
    customInstructions: '',
  }
  const git: GitAdapter = {
    async getFile() { return null },
    async getTree() { return [] },
    async createBranch() {},
    async commitFiles() { return 'sha' },
    async createPR() { return { id: '1', url: '', title: '', body: '', branch: '', status: 'open' } },
    async getPRDiff() { return '' },
    async addPRComment() {},
    async mergePR() {},
    async getRecentCommits() { return [] },
  }
  const task = {} as TaskAdapter

  test('discussion sits after the issue body and before review comments, and an empty section adds nothing', async () => {
    const builder = createContextBuilder({ taskAdapter: task, gitAdapter: git })
    const withDiscussion = await builder.build({
      agent,
      issue,
      project,
      discussion: '## Discussion\n\n**jvial** (2026-09-18):\nstart from the tests',
      reviewComments: 'add types',
    })
    expect(withDiscussion.userMessage.indexOf('Correct answer.txt')).toBeLessThan(withDiscussion.userMessage.indexOf('## Discussion'))
    expect(withDiscussion.userMessage.indexOf('## Discussion')).toBeLessThan(withDiscussion.userMessage.indexOf('## Review Comments'))
    expect(withDiscussion.userMessage).toContain('start from the tests')

    const without = await builder.build({ agent, issue, project, discussion: '' })
    expect(without.userMessage).not.toContain('## Discussion')
  })
})
