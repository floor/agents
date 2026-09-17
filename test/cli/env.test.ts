import { test, expect, describe } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv, projectEnvPath, loadProjectEnv } from '../../src/cli/env.ts'

describe('parseEnv', () => {
  test('reads KEY=VALUE, drops comments, blanks, quotes and an export prefix', () => {
    expect(parseEnv('# chat\nTELEGRAM_CHAT_ID=-100\nexport TOKEN="a=b"\n\nBAD LINE\nEMPTY=\n')).toEqual({
      TELEGRAM_CHAT_ID: '-100', TOKEN: 'a=b', EMPTY: '',
    })
  })
})

describe('loadProjectEnv', () => {
  test('the manifest directory carries its own .env, and the environment wins over it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'floor-env-'))
    try {
      const config = join(dir, 'agents.yaml')
      expect(projectEnvPath(config)).toBe(join(dir, '.env'))
      await Bun.write(join(dir, '.env'), 'TELEGRAM_CHAT_ID=-42\nTELEGRAM_BOT_TOKEN=t\n')
      const env: Record<string, string | undefined> = { TELEGRAM_BOT_TOKEN: 'from-shell' }
      expect(await loadProjectEnv(config, env)).toEqual(['TELEGRAM_CHAT_ID'])
      expect(env).toEqual({ TELEGRAM_BOT_TOKEN: 'from-shell', TELEGRAM_CHAT_ID: '-42' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('no file, nothing loaded', async () => {
    const env: Record<string, string | undefined> = {}
    expect(await loadProjectEnv('/nowhere/agents.yaml', env)).toEqual([])
    expect(env).toEqual({})
  })
})
