import { test, expect, describe } from 'bun:test'
import { bridgeFor, startExternalVoters, type SpawnedBridge } from '../../scripts/lib/bridges.ts'
import { hasVerdict, reviewWithRetry, buildCursorReviewPrompt } from '../../scripts/lib/cursor-review.ts'
import type { Gateway } from '@floor-agents/gateway'

const agent = (id: string, provider: string, model = 'local') => ({ id, name: id, external: true, llm: { provider, model, temperature: 0.3, maxTokens: 16000 } })

describe('bridgeFor — provider picks the bridge', () => {
  test('cursor runs the Cursor bridge with the manifest model and agent id', () => {
    const plan = bridgeFor(agent('grok-reviewer', 'cursor', 'cursor-grok-4.6-high'), '/code/vlist')
    expect(plan.script).toBe('cursor-agent-bridge.ts')
    expect(plan.env).toMatchObject({ AGENT_ID: 'grok-reviewer', CURSOR_MODEL: 'cursor-grok-4.6-high', REVIEW_CWD: '/code/vlist' })
  })

  test('any id can use any transport: GPT through Cursor needs no new code', () => {
    const plan = bridgeFor(agent('gpt', 'cursor', 'gpt-5'), '/code/vlist')
    expect(plan.script).toBe('cursor-agent-bridge.ts')
    expect(plan.env.CURSOR_MODEL).toBe('gpt-5')
  })

  test('grok-cli keeps the xAI bridge available per project', () => {
    const plan = bridgeFor(agent('grok', 'grok-cli'), '/code/vlist')
    expect(plan.script).toBe('grok-agent.ts')
    expect(plan.env).toEqual({ AGENT_ID: 'grok', GROK_CWD: '/code/vlist' })
  })

  test('codex-cli passes a real model through and omits the placeholder', () => {
    expect(bridgeFor(agent('codex', 'codex-cli', 'gpt-5-codex'), '/r').env.CODEX_MODEL).toBe('gpt-5-codex')
    expect(bridgeFor(agent('codex', 'codex-cli'), '/r').env.CODEX_MODEL).toBeUndefined()
  })

  test('older manifests that named a vendor still resolve by agent id', () => {
    expect(bridgeFor(agent('codex', 'openai'), '/r').script).toBe('codex-agent.ts')
    expect(bridgeFor(agent('grok', 'openai'), '/r').script).toBe('grok-agent.ts')
    expect(bridgeFor(agent('antigravity', 'gemini', 'gemini-3.1-pro-high'), '/r').script).toBe('agy-agent-bridge.ts')
  })

  test('an unknown transport fails before anything starts', () => {
    expect(() => bridgeFor(agent('gpt', 'openai'), '/r')).toThrow(/No bridge for external agent "gpt"/)
  })

  test('cursor without a model is refused rather than using some default', () => {
    expect(() => bridgeFor(agent('grok', 'cursor'), '/r')).toThrow(/names no model/)
  })

  test('antigravity runs the agy bridge with the manifest model and agent id', () => {
    const plan = bridgeFor(agent('gemini', 'antigravity', 'gemini-3.1-pro-high'), '/code/vlist')
    expect(plan.script).toBe('agy-agent-bridge.ts')
    expect(plan.env).toMatchObject({ AGENT_ID: 'gemini', AGY_MODEL: 'gemini-3.1-pro-high', REVIEW_CWD: '/code/vlist' })
  })

  test('antigravity without a model is refused rather than using some default', () => {
    expect(() => bridgeFor(agent('gemini', 'antigravity'), '/r')).toThrow(/names no model/)
  })
})

describe('bridgeFor — private sources', () => {
  const denied = ['/docs/findings.html', '/docs/vlist.md']

  test('the Cursor, Codex and Antigravity bridges carry the denials into their sandbox', () => {
    expect(bridgeFor(agent('grok', 'cursor', 'cursor-grok-4.6-high'), '/r', denied, {}).env.FLOOR_AGENTS_DENY_READ).toBe('/docs/findings.html,/docs/vlist.md')
    expect(bridgeFor(agent('codex', 'codex-cli'), '/r', denied, {}).env.FLOOR_AGENTS_DENY_READ).toBe('/docs/findings.html,/docs/vlist.md')
    expect(bridgeFor(agent('gemini', 'antigravity', 'gemini-3.1-pro-high'), '/r', denied, {}).env.FLOOR_AGENTS_DENY_READ).toBe('/docs/findings.html,/docs/vlist.md')
  })

  test('denials already set for the run are kept', () => {
    expect(bridgeFor(agent('codex', 'codex-cli'), '/r', denied, { FLOOR_AGENTS_DENY_READ: '/srv/x' }).env.FLOOR_AGENTS_DENY_READ)
      .toBe('/srv/x,/docs/findings.html,/docs/vlist.md')
  })

  test('with nothing to deny, the bridge environment is unchanged', () => {
    expect(bridgeFor(agent('codex', 'codex-cli'), '/r', [], {}).env).toEqual({ AGENT_ID: 'codex', CODEX_CWD: '/r' })
  })

  test('a bridge that cannot be sandboxed is refused for an untrusted provider', () => {
    expect(() => bridgeFor(agent('grok', 'grok-cli'), '/r', denied, {})).toThrow(/cannot be sandboxed/)
    expect(bridgeFor(agent('antigravity', 'antigravity', 'gemini-3.1-pro-high'), '/r', denied, {}).script).toBe('agy-agent-bridge.ts')
    expect(bridgeFor(agent('antigravity', 'antigravity', 'gemini-3.1-pro-high'), '/r', [], {}).script).toBe('agy-agent-bridge.ts')
  })
})

describe('cursor review', () => {
  test('recognises both committees\' verdict lines', () => {
    expect(hasVerdict('analysis…\n**VOTE: APPROVE**')).toBe(true)
    expect(hasVerdict('VOTE: reject')).toBe(true)
    expect(hasVerdict('RECOMMEND: B')).toBe(true)
    expect(hasVerdict("I'll review the proposal now.")).toBe(false)
  })

  test('retries once when a reply carries no verdict', async () => {
    const replies = ["I'll review it now.", 'Found issues.\nVOTE: REJECT']
    let calls = 0
    const out = await reviewWithRetry(async () => replies[calls++]!)
    expect(calls).toBe(2)
    expect(out).toContain('VOTE: REJECT')
  })

  test('returns the empty reply after the retry, so the committee abstains', async () => {
    let calls = 0
    const out = await reviewWithRetry(async () => { calls++; return 'nothing to say' })
    expect(calls).toBe(2)
    expect(hasVerdict(out)).toBe(false)
  })

  test('the prompt tells the reviewer it cannot modify anything', () => {
    const prompt = buildCursorReviewPrompt({ title: 'T', body: 'B', systemPrompt: 'S' })
    expect(prompt).toContain('you cannot modify anything')
  })
})

describe('startExternalVoters', () => {
  const manifest = { guardrails: {}, sources: {} }
  const logs: string[] = []

  function fakeGateway(connected: Set<string>) {
    const state = { started: false, stopped: false }
    const gateway: Gateway = {
      start() { state.started = true },
      stop() { state.stopped = true },
      assign() {},
      waitForResult() { return Promise.reject(new Error('not used')) },
      getConnectedAgents() { return [] },
      isAgentConnected(id) { return connected.has(id) },
      onAgentConnect() {},
      onAgentDisconnect() {},
    }
    return { gateway, state }
  }

  function connectedProc(id: string, connected: Set<string>, killed: string[]): SpawnedBridge {
    connected.add(id)
    return {
      kill() { killed.push(id) },
      exited: new Promise(() => {}),
      exitCode: null,
    }
  }

  function deadProc(code: number, killed: string[], id: string): SpawnedBridge {
    return {
      kill() { killed.push(id) },
      exited: Promise.resolve(code),
      exitCode: code,
    }
  }

  test('starts a gateway when none is running, counts a connected bridge, and stops both', async () => {
    const connected = new Set<string>()
    const killed: string[] = []
    const { gateway, state } = fakeGateway(connected)
    const session = await startExternalVoters(
      [agent('codex', 'codex-cli')],
      {
        port: 3199,
        repo: '/r',
        log: m => logs.push(m),
        manifest,
        createGateway: () => gateway,
        spawn: (_script, env) => connectedProc(env.AGENT_ID!, connected, killed),
      },
    )

    expect(state.started).toBe(true)
    expect(session.started.get('codex')).toEqual({ ok: true })
    session.stop()
    expect(killed).toEqual(['codex'])
    expect(state.stopped).toBe(true)
  })

  test('two reviews at once do not fight over a port: each owned gateway takes a free one', async () => {
    // Measured: two `run`s, both on the configured 3100 — the second lost Codex ("Is port 3100 in use?", mtrl #92).
    const urls: string[] = []
    const open = () => startExternalVoters([agent('codex', 'codex-cli')], {
      port: 3199,
      repo: '/r',
      log: m => logs.push(m),
      manifest,
      connectTimeoutMs: 20,
      spawn: (_script, env) => { urls.push(env.GATEWAY_URL!); return deadProc(1, [], 'codex') },
    })
    const first = await open()
    const second = await open()
    try {
      const ports = [first, second].map(s => s.gateway.getPort!())
      expect(ports[0]).toBeGreaterThan(0)
      expect(ports[1]).toBeGreaterThan(0)
      expect(ports[0]).not.toBe(ports[1])
      expect(ports).not.toContain(3199)
      // The bridge is sent to the port that was bound, not to the configured one.
      expect(urls).toEqual(ports.map(p => `ws://localhost:${p}`))
    } finally {
      first.stop()
      second.stop()
    }
  })

  test('a gateway the caller holds keeps its own port for the bridges', async () => {
    const connected = new Set<string>()
    const { gateway } = fakeGateway(connected)
    let url = ''
    const session = await startExternalVoters([agent('codex', 'codex-cli')], {
      port: 3199, repo: '/r', log: m => logs.push(m), manifest, gateway: { ...gateway, getPort: () => 4242 },
      spawn: (_script, env) => { url = env.GATEWAY_URL!; return connectedProc(env.AGENT_ID!, connected, []) },
    })
    session.stop()
    expect(url).toBe('ws://localhost:4242')
  })

  test('reuses a running gateway and does not stop it', async () => {
    const connected = new Set<string>()
    const killed: string[] = []
    const { gateway, state } = fakeGateway(connected)
    const session = await startExternalVoters(
      [agent('codex', 'codex-cli')],
      {
        port: 3199,
        repo: '/r',
        log: m => logs.push(m),
        manifest,
        gateway,
        spawn: (_script, env) => connectedProc(env.AGENT_ID!, connected, killed),
      },
    )

    expect(state.started).toBe(false)
    expect(session.started.get('codex')).toEqual({ ok: true })
    session.stop()
    expect(killed).toEqual(['codex'])
    expect(state.stopped).toBe(false)
  })

  test('a bridge that exits before connecting fails immediately and is killed', async () => {
    const connected = new Set<string>()
    const killed: string[] = []
    const { gateway } = fakeGateway(connected)
    const session = await startExternalVoters(
      [agent('codex', 'codex-cli')],
      {
        port: 3199,
        repo: '/r',
        log: m => logs.push(m),
        manifest,
        gateway,
        connectTimeoutMs: 200,
        spawn: (_script, env) => deadProc(127, killed, env.AGENT_ID!),
      },
    )

    expect(session.started.get('codex')).toEqual({ ok: false, reason: 'bridge process exited (code 127)' })
    expect(killed).toEqual(['codex'])
    session.stop()
  })

  test('a bridge that never connects times out and is killed', async () => {
    const connected = new Set<string>()
    const killed: string[] = []
    const { gateway } = fakeGateway(connected)
    const session = await startExternalVoters(
      [agent('grok', 'cursor', 'cursor-grok-4.6-high')],
      {
        port: 3199,
        repo: '/r',
        log: m => logs.push(m),
        manifest,
        gateway,
        connectTimeoutMs: 80,
        spawn: () => ({
          kill() { killed.push('grok') },
          exited: new Promise(() => {}),
          exitCode: null,
        }),
      },
    )

    expect(session.started.get('grok')?.ok).toBe(false)
    expect(session.started.get('grok')).toMatchObject({ ok: false })
    expect((session.started.get('grok') as { reason: string }).reason).toContain('did not connect')
    expect(killed).toEqual(['grok'])
    session.stop()
  })

  test('a member that votes by comment is not spawned', async () => {
    const spawned: string[] = []
    const { gateway } = fakeGateway(new Set())
    const session = await startExternalVoters(
      [{ ...agent('codex', 'codex-cli'), voteByComment: true }],
      {
        port: 3199,
        repo: '/r',
        log: m => logs.push(m),
        manifest,
        gateway,
        spawn: script => {
          spawned.push(script)
          return { kill() {}, exited: new Promise(() => {}), exitCode: null }
        },
      },
    )

    expect(spawned).toEqual([])
    expect(session.started.size).toBe(0)
    session.stop()
  })
})
