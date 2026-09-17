import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NATIVE_PROVIDERS, nativeAgentArgv, parseNativeResult, spawnNativeAgent } from '../../packages/orchestrator/src/native-runner.ts'

describe('nativeAgentArgv', () => {
  test('cursor is a native provider alongside claude-code', () => {
    expect(NATIVE_PROVIDERS.has('cursor')).toBe(true)
    expect(NATIVE_PROVIDERS.has('claude-code')).toBe(true)
  })

  test('a Claude implementer gets edit tools; a Claude reviewer does not', () => {
    const impl = nativeAgentArgv({ provider: 'claude-code', role: 'implement', prompt: 'p' })
    const review = nativeAgentArgv({ provider: 'claude-code', role: 'review', prompt: 'p' })
    expect(impl[impl.indexOf('--allowedTools') + 1]).toBe('Read,Edit,Write,Bash,Glob,Grep')
    expect(review[review.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep,Bash')
  })

  test('a Cursor implementer may run the shell; a Cursor reviewer may not', () => {
    expect(nativeAgentArgv({ provider: 'cursor', role: 'implement', prompt: 'p' })).toContain('--force')
    expect(nativeAgentArgv({ provider: 'cursor', role: 'review', prompt: 'p' })).toContain('--trust')
  })

  test('passes the manifest model through', () => {
    const argv = nativeAgentArgv({ provider: 'cursor', role: 'implement', prompt: 'p', model: 'cursor-grok-4.6-high' })
    expect(argv[0]).toBe('cursor-agent')
    expect(argv[argv.indexOf('--model') + 1]).toBe('cursor-grok-4.6-high')
  })

  test('an unknown provider has no native runner', () => {
    expect(() => nativeAgentArgv({ provider: 'openai', role: 'implement', prompt: 'p' })).toThrow(/No native runner/)
  })
})

describe('parseNativeResult', () => {
  test('reads Claude cost and result', () => {
    expect(parseNativeResult('claude-code', '{"result":"done","total_cost_usd":0.12}', '')).toEqual({ resultText: 'done', cost: 0.12, isError: false })
  })

  test('reads the Cursor envelope after progress output and reports its error flag', () => {
    const out = 'working…\n{"type":"result","subtype":"success","is_error":true,"duration_ms":1,"result":"boom"}'
    expect(parseNativeResult('cursor', out, '')).toEqual({ resultText: 'boom', cost: 0, isError: true })
  })

  test('Cursor output with no envelope is an error, not a success', () => {
    expect(parseNativeResult('cursor', 'command not found', '').isError).toBe(true)
  })
})

// The native launch path end to end, enforced by the operating system. Fake
// `cursor-agent` and `claude` scripts go first on PATH and try to write inside
// and outside their working directory; a temporary directory stands in for home.
describe.skipIf(process.platform !== 'darwin' || !Bun.which('sandbox-exec'))('spawnNativeAgent under sandbox-exec', () => {
  let home = ''
  let work = ''
  let bin = ''
  const savedPath = process.env.PATH

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'floor-native-'))
    work = join(home, 'work')
    bin = await mkdtemp(join(tmpdir(), 'floor-native-bin-'))
    await mkdir(work)
    const attempt = [
      '#!/bin/sh',
      'echo x > "$FLOOR_TEST_HOME/outside.txt" 2>/dev/null',
      'echo x > ./inside.txt 2>/dev/null',
    ]
    await Bun.write(join(bin, 'cursor-agent'), [...attempt, `echo '{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"result":"cursor done"}'`].join('\n'))
    await Bun.write(join(bin, 'claude'), [...attempt, `echo '{"result":"claude done","total_cost_usd":0}'`].join('\n'))
    await chmod(join(bin, 'cursor-agent'), 0o755)
    await chmod(join(bin, 'claude'), 0o755)
    process.env.PATH = `${bin}:${savedPath}`
    process.env.FLOOR_TEST_HOME = home
  })

  afterAll(async () => {
    process.env.PATH = savedPath
    delete process.env.FLOOR_TEST_HOME
    await rm(home, { recursive: true, force: true })
    await rm(bin, { recursive: true, force: true })
  })

  test('an implementer writes its worktree and nothing else', async () => {
    const result = await spawnNativeAgent({ provider: 'cursor', role: 'implement', prompt: 'p', cwd: work, writable: [work], home, timeoutMs: 20_000 })
    expect(result.exitCode).toBe(0)
    expect(result.resultText).toBe('cursor done')
    expect(await Bun.file(join(work, 'inside.txt')).exists()).toBe(true)
    expect(await Bun.file(join(home, 'outside.txt')).exists()).toBe(false)
  })

  test('a reviewer writes nothing, not even its working directory', async () => {
    await rm(join(work, 'inside.txt'), { force: true })
    const result = await spawnNativeAgent({ provider: 'claude-code', role: 'review', prompt: 'p', cwd: work, writable: [], home, timeoutMs: 20_000 })
    expect(result.resultText).toBe('claude done')
    expect(await Bun.file(join(work, 'inside.txt')).exists()).toBe(false)
    expect(await Bun.file(join(home, 'outside.txt')).exists()).toBe(false)
  })
})
