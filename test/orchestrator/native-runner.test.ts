import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NATIVE_PROVIDERS, DEFAULT_TURN_TIMEOUT_MS, DEFAULT_MAX_TURNS, turnTimeoutMs, failureReason, nativeAgentArgv, nativeImplementerInstructions, parseNativeResult, spawnNativeAgent } from '../../packages/orchestrator/src/native-runner.ts'
import { sandboxAvailable } from '../helpers/sandbox.ts'

describe('nativeAgentArgv', () => {
  test('cursor is a native provider alongside claude-code and antigravity', () => {
    expect(NATIVE_PROVIDERS.has('cursor')).toBe(true)
    expect(NATIVE_PROVIDERS.has('claude-code')).toBe(true)
    expect(NATIVE_PROVIDERS.has('antigravity')).toBe(true)
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

  test('an Antigravity implementer skips permission prompts; a reviewer stays in plan mode', () => {
    const impl = nativeAgentArgv({ provider: 'antigravity', role: 'implement', prompt: 'p', model: 'gemini-3.1-pro-high', timeoutMs: 2_400_000 })
    expect(impl[0]).toBe('agy')
    expect(impl).toContain('--dangerously-skip-permissions')
    expect(impl).not.toContain('--mode')
    expect(impl[impl.indexOf('--model') + 1]).toBe('gemini-3.1-pro-high')
    expect(impl[impl.indexOf('--print-timeout') + 1]).toBe('40m')
    const review = nativeAgentArgv({ provider: 'antigravity', role: 'review', prompt: 'p' })
    expect(review[review.indexOf('--mode') + 1]).toBe('plan')
    expect(review).not.toContain('--dangerously-skip-permissions')
    expect(review[review.indexOf('--print-timeout') + 1]).toBe('10m')
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
    expect(parseNativeResult('cursor', out, '')).toEqual({ resultText: 'boom', cost: 0, isError: true, subtype: 'success' })
  })

  test('Cursor output with no envelope is an error, not a success', () => {
    expect(parseNativeResult('cursor', 'command not found', '').isError).toBe(true)
  })

  test('reads the agy envelope after progress output; status other than SUCCESS is an error', () => {
    const out = 'working…\n{"conversation_id":"x","status":"ERROR","response":"boom","duration_seconds":1,"num_turns":0}'
    expect(parseNativeResult('antigravity', out, '')).toEqual({ resultText: 'boom', cost: 0, isError: true, subtype: 'ERROR' })
  })

  test('agy output with no envelope is an error, not a success', () => {
    expect(parseNativeResult('antigravity', 'command not found', '').isError).toBe(true)
  })

  test('agy print-timeout is reported as a budget, not a crash', () => {
    const parsed = parseNativeResult('antigravity', '{"status":"ERROR","response":"print timeout exceeded"}', '')
    expect(parsed.isError).toBe(true)
    expect(parsed.subtype).toBe('TIMEOUT')
    expect(failureReason(1, parsed.subtype, { timeoutMs: 600_000, maxTurns: 300 })).toContain('did not finish within 10 minutes')
  })
})

// The native launch path end to end, enforced by the operating system. Fake
// `cursor-agent` and `claude` scripts go first on PATH and try to write inside
// and outside their working directory; a temporary directory stands in for home.
describe.skipIf(!sandboxAvailable())('spawnNativeAgent under sandbox-exec', () => {
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
      '[ -n "$FLOOR_TEST_PRIVATE" ] && cat "$FLOOR_TEST_PRIVATE" > "$FLOOR_TEST_LEAK" 2>/dev/null',
    ]
    await Bun.write(join(bin, 'cursor-agent'), [...attempt, `echo '{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"result":"cursor done"}'`].join('\n'))
    await Bun.write(join(bin, 'claude'), [...attempt, `echo '{"result":"claude done","total_cost_usd":0}'`].join('\n'))
    await Bun.write(join(bin, 'agy'), [...attempt, `echo '{"conversation_id":"x","status":"SUCCESS","response":"agy done","duration_seconds":1,"num_turns":1}'`].join('\n'))
    await chmod(join(bin, 'cursor-agent'), 0o755)
    await chmod(join(bin, 'claude'), 0o755)
    await chmod(join(bin, 'agy'), 0o755)
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

  test('an antigravity implementer writes its worktree and nothing else', async () => {
    await rm(join(work, 'inside.txt'), { force: true })
    const result = await spawnNativeAgent({ provider: 'antigravity', role: 'implement', prompt: 'p', cwd: work, writable: [work], home, timeoutMs: 20_000 })
    expect(result.exitCode).toBe(0)
    expect(result.resultText).toBe('agy done')
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

  test('an antigravity reviewer writes nothing, not even its working directory', async () => {
    await rm(join(work, 'inside.txt'), { force: true })
    const result = await spawnNativeAgent({ provider: 'antigravity', role: 'review', prompt: 'p', cwd: work, writable: [], home, timeoutMs: 20_000 })
    expect(result.resultText).toBe('agy done')
    expect(await Bun.file(join(work, 'inside.txt')).exists()).toBe(false)
    expect(await Bun.file(join(home, 'outside.txt')).exists()).toBe(false)
  })

  test('a private source its provider is not trusted with cannot be read', async () => {
    // The leak file sits outside home, where the sandbox allows writes, so only
    // the read denial can keep the private text out of it.
    const secret = join(home, 'findings.html')
    const leak = join(bin, 'leak.txt')
    await Bun.write(secret, 'PRIVATE_TEXT')
    process.env.FLOOR_TEST_PRIVATE = secret
    process.env.FLOOR_TEST_LEAK = leak
    try {
      const open = await spawnNativeAgent({ provider: 'cursor', role: 'implement', prompt: 'p', cwd: work, writable: [work], home, timeoutMs: 20_000 })
      expect(open.exitCode).toBe(0)
      expect(await Bun.file(leak).text()).toBe('PRIVATE_TEXT')
      await rm(leak, { force: true })
      const denied = await spawnNativeAgent({ provider: 'cursor', role: 'implement', prompt: 'p', cwd: work, writable: [work], denyRead: [secret], home, timeoutMs: 20_000 })
      expect(denied.exitCode).toBe(0)
      expect(await Bun.file(leak).exists() ? await Bun.file(leak).text() : '').toBe('')
      await rm(leak, { force: true })
      const agyDenied = await spawnNativeAgent({ provider: 'antigravity', role: 'implement', prompt: 'p', cwd: work, writable: [work], denyRead: [secret], home, timeoutMs: 20_000 })
      expect(agyDenied.exitCode).toBe(0)
      expect(await Bun.file(leak).exists() ? await Bun.file(leak).text() : '').toBe('')
    } finally {
      delete process.env.FLOOR_TEST_PRIVATE
      delete process.env.FLOOR_TEST_LEAK
    }
  })
})

describe('nativeImplementerInstructions', () => {
  test('never names API-path tools, and tells the agent to edit the tree instead of printing it', () => {
    const text = nativeImplementerInstructions([{ command: ['bun', 'test'] }]).join('\n')
    expect(text).not.toContain('write_file')
    expect(text).not.toContain('pr_description')
    expect(text).toContain('Do not commit, push, or open a PR')
    expect(text).toContain('own editing tools')
    expect(text).toContain('The engine reads the working tree, not your message')
  })
})

describe("turnTimeoutMs", () => {
  test("a manifest timeout replaces the default, and the environment replaces both", () => {
    expect(turnTimeoutMs(undefined, {})).toBe(DEFAULT_TURN_TIMEOUT_MS)
    expect(turnTimeoutMs(1_800_000, {})).toBe(1_800_000)
    expect(turnTimeoutMs(1_800_000, { FLOOR_AGENTS_AGENT_TIMEOUT_MS: "60000" })).toBe(60_000)
  })

  test("a value that is not a positive number is ignored rather than cutting every turn short", () => {
    for (const raw of ["", "soon", "0", "-1", "NaN"]) {
      expect(turnTimeoutMs(undefined, { FLOOR_AGENTS_AGENT_TIMEOUT_MS: raw })).toBe(DEFAULT_TURN_TIMEOUT_MS)
    }
  })
})

describe("turn caps", () => {
  test("the cap fits the role, and the manifest can raise it", () => {
    const cap = (argv: string[]) => argv[argv.indexOf('--max-turns') + 1]
    expect(cap(nativeAgentArgv({ provider: 'claude-code', role: 'implement', prompt: 'p' }))).toBe(String(DEFAULT_MAX_TURNS.implement))
    expect(cap(nativeAgentArgv({ provider: 'claude-code', role: 'review', prompt: 'p' }))).toBe(String(DEFAULT_MAX_TURNS.review))
    expect(cap(nativeAgentArgv({ provider: 'claude-code', role: 'implement', prompt: 'p', maxTurns: 500 }))).toBe('500')
    // An implementer edits, runs tests and iterates; 25 ran out four minutes into floor/vlist#220.
    expect(DEFAULT_MAX_TURNS.implement).toBeGreaterThan(100)
  })

  test("a capped turn is reported as capped, not as a crash", () => {
    const parsed = parseNativeResult('claude-code', JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 25 }), '')
    expect(parsed.isError).toBe(true)
    expect(parsed.subtype).toBe('error_max_turns')
    const budget = { timeoutMs: 600_000, maxTurns: 25 }
    expect(failureReason(1, parsed.subtype, budget)).toContain('cap of 25 tool calls')
    expect(failureReason(1, parsed.subtype, budget)).toContain('maxTurns')
    expect(failureReason(143, undefined, budget)).toContain('did not finish within 10 minutes')
    expect(failureReason(2, undefined, budget)).toBe('failed (exit 2)')
    expect(failureReason(1, 'error_during_execution', budget)).toBe('failed (exit 1, error_during_execution)')
  })
})

describe('continuing a session', () => {
  test('cursor and claude resume by id; a fresh turn carries no resume flag', () => {
    const cursor = nativeAgentArgv({ provider: 'cursor', role: 'implement', prompt: 'p', resume: 'abc' })
    expect(cursor.slice(0, 3)).toEqual(['cursor-agent', '--resume', 'abc'])
    const claude = nativeAgentArgv({ provider: 'claude-code', role: 'implement', prompt: 'p', resume: 'abc' })
    expect(claude[claude.indexOf('--resume') + 1]).toBe('abc')
    for (const provider of ['cursor', 'claude-code', 'antigravity']) {
      expect(nativeAgentArgv({ provider, role: 'implement', prompt: 'p' })).not.toContain('--resume')
    }
  })

  test('agy has no resume: the flag is not invented for it', () => {
    expect(nativeAgentArgv({ provider: 'antigravity', role: 'implement', prompt: 'p', resume: 'abc' })).not.toContain('--resume')
  })

  test('the session id is read from the envelope of the CLIs that give one', () => {
    const cursor = parseNativeResult('cursor', '{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"result":"ok","session_id":"19862f6c"}', '')
    expect(cursor.sessionId).toBe('19862f6c')
    const claude = parseNativeResult('claude-code', '{"result":"ok","total_cost_usd":0.1,"is_error":false,"session_id":"s-9"}', '')
    expect(claude.sessionId).toBe('s-9')
    expect(parseNativeResult('cursor', '{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"result":"ok"}', '').sessionId).toBeUndefined()
  })
})
