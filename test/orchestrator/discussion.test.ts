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

  test('drops the oldest kept comments to fit 8,000 characters', () => {
    const body = 'x'.repeat(1_000)
    const comments = Array.from({ length: 10 }, (_, i) => comment({
      author: 'a',
      body: `${i}-${body}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    }))
    const section = discussionSection(comments)
    expect(section.length).toBeLessThanOrEqual(8_000)
    expect(section).toContain('earlier comments omitted')
    expect(section).toContain(`9-${body}`)
    expect(section).not.toContain(`0-${body}`)
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
