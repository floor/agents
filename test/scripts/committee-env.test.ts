import { test, expect, describe } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { committeeConfigPath, parseMaxRounds, selectVoters, telegramSettings } from '../../scripts/lib/committee-env.ts'

describe('committeeConfigPath', () => {
  test("reads the committee from the reviewed repository's manifest", () => {
    expect(committeeConfigPath('/code/vlist', {})).toBe('/code/vlist/.agents/agents.yaml')
  })

  test('expands a home-relative repository path', () => {
    expect(committeeConfigPath('~/Code/floor/vlist', {})).toBe(join(homedir(), 'Code/floor/vlist/.agents/agents.yaml'))
  })

  test('COMMITTEE_CONFIG overrides the default', () => {
    expect(committeeConfigPath('/code/vlist', { COMMITTEE_CONFIG: '/elsewhere/c.yaml' })).toBe('/elsewhere/c.yaml')
  })
})

describe('selectVoters', () => {
  const agents = [
    { id: 'cto', capabilities: ['read_code', 'create_pr'] },
    { id: 'grok', capabilities: ['read_code', 'write_code'] },
    { id: 'claude', capabilities: ['review_rfc', 'vote'] },
    { id: 'codex', capabilities: ['review_rfc', 'vote'] },
  ]

  test('keeps agents that can vote and are named in AGENTS', () => {
    expect(selectVoters(agents, ['claude', 'codex', 'grok'], 'm.yaml').map(a => a.id)).toEqual(['claude', 'codex'])
  })

  test('an implementer named in AGENTS does not join the committee', () => {
    expect(selectVoters(agents, ['claude', 'grok'], 'm.yaml').map(a => a.id)).toEqual(['claude'])
  })

  test('refuses an empty committee rather than deliberating with no one', () => {
    expect(() => selectVoters(agents, ['cto', 'grok'], 'm.yaml')).toThrow(/No committee members in m\.yaml/)
  })
})

describe('parseMaxRounds', () => {
  test('defaults to 3 when unset', () => {
    expect(parseMaxRounds(undefined)).toBe(3)
  })

  test('accepts a positive whole number', () => {
    expect(parseMaxRounds('5')).toBe(5)
    expect(parseMaxRounds(' 2 ')).toBe(2)
  })

  // Each of these once produced a zero-round run or a silently different cap.
  for (const bad of ['three', '', '0', '-1', '2.5', '3x', 'NaN']) {
    test(`refuses ${JSON.stringify(bad)}`, () => {
      expect(() => parseMaxRounds(bad)).toThrow(/MAX_ROUNDS must be a positive whole number/)
    })
  }
})

describe('telegramSettings', () => {
  const creds = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }

  test('a live run with both credentials streams to Telegram', () => {
    expect(telegramSettings(creds, false)).toEqual({ token: 't', chatId: '1', allowFrom: undefined })
  })

  test('parses the allowlist', () => {
    expect(telegramSettings({ ...creds, TELEGRAM_ALLOW_FROM: ' 42, 7 ,' }, false)?.allowFrom).toEqual(['42', '7'])
  })

  test('a dry run never sends to Telegram, even with credentials', () => {
    expect(telegramSettings(creds, true)).toBeNull()
  })

  test('stays off when either credential is missing', () => {
    expect(telegramSettings({ TELEGRAM_BOT_TOKEN: 't' }, false)).toBeNull()
    expect(telegramSettings({ TELEGRAM_CHAT_ID: '1' }, false)).toBeNull()
  })
})
