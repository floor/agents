import { test, expect, describe } from 'bun:test'
import type { TaskAdapter } from '@floor-agents/core'
import { mirrorComments, channelText } from '../../packages/orchestrator/src/task-mirror.ts'
import { createMockChannel } from '../../packages/orchestrator/src/team-channel.ts'

const stubAdapter = (record: string[], fail = false): TaskAdapter => ({
  async *watchIssues() {},
  async getIssue() { return null },
  async createIssue() { throw new Error('unused') },
  async updateIssue() {},
  async addComment(id: string, text: string) {
    if (fail) throw new Error('issue write failed')
    record.push(`${id}:${text}`)
  },
  async setStatus() {},
  async setLabel() {},
  async removeLabel() {},
} as unknown as TaskAdapter)

describe('mirrorComments', () => {
  test('a run comment reaches the issue and the channel, with the issue first', async () => {
    const record: string[] = []
    const channel = createMockChannel()
    const mirrored = mirrorComments(stubAdapter(record), channel, { from: 'vlist' })
    await mirrored.addComment('210', '⏳ **Grok** is working on the code...')
    expect(record).toEqual(['210:⏳ **Grok** is working on the code...'])
    expect(channel.posted).toEqual([{ from: 'vlist', text: '#210 · ⏳ Grok is working on the code...' }])
  })

  test('a channel that refuses the message never fails the run', async () => {
    const record: string[] = []
    const failing = { ...createMockChannel(), post: async () => { throw new Error('chat not found') } }
    const logged: string[] = []
    const mirrored = mirrorComments(stubAdapter(record), failing, { log: m => logged.push(m) })
    await mirrored.addComment('1', 'done')
    expect(record).toEqual(['1:done'])
    expect(logged[0]).toContain('chat not found')
  })

  test('a failed issue comment is still an error: the record comes first', async () => {
    const channel = createMockChannel()
    const mirrored = mirrorComments(stubAdapter([], true), channel, {})
    await expect(mirrored.addComment('1', 'x')).rejects.toThrow('issue write failed')
    expect(channel.posted).toEqual([])
  })

  test('the rest of the adapter is untouched', async () => {
    const channel = createMockChannel()
    const base = stubAdapter([])
    const mirrored = mirrorComments(base, channel, {})
    expect(await mirrored.getIssue('1')).toBeNull()
    expect(mirrored.setLabel).toBe(base.setLabel)
  })
})

describe('channelText', () => {
  test('drops the markdown a chat message does not need, and keeps the words', () => {
    expect(channelText('✅ **Grok** completed work (native mode):\n```\n 2 files changed\n```\n> 3m | $0.00'))
      .toBe('✅ Grok completed work (native mode):\n 2 files changed\n3m | $0.00')
    expect(channelText('`scripts/release.ts` fixed')).toBe('scripts/release.ts fixed')
  })
})
