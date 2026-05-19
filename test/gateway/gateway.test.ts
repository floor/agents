import { test, expect, describe, afterEach } from 'bun:test'
import { createGateway, validateAgentMessage, type Gateway } from '@floor-agents/gateway'

let gateway: Gateway | null = null
const TEST_PORT = 9876
const TEST_TOKEN = 'test-secret-token'

afterEach(() => {
  gateway?.stop()
  gateway = null
})

describe('gateway server', () => {
  test('starts and responds to status endpoint', async () => {
    gateway = createGateway({ port: TEST_PORT })
    gateway.start()

    const res = await fetch(`http://localhost:${TEST_PORT}/api/status`)
    const data = await res.json() as { agents: unknown[]; pendingTasks: number }

    expect(res.status).toBe(200)
    expect(data.agents).toEqual([])
    expect(data.pendingTasks).toBe(0)
  })

  test('returns 404 for unknown routes', async () => {
    gateway = createGateway({ port: TEST_PORT })
    gateway.start()

    const res = await fetch(`http://localhost:${TEST_PORT}/nope`)
    expect(res.status).toBe(404)
  })
})

describe('websocket protocol', () => {
  test('agent registers and receives welcome', async () => {
    gateway = createGateway({ port: TEST_PORT })
    gateway.start()

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`)

    const messages: unknown[] = []
    const connected = new Promise<void>(resolve => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'register',
          agentId: 'test-agent',
          name: 'Test Agent',
          capabilities: ['vote'],
        }))
      }
      ws.onmessage = (event) => {
        messages.push(JSON.parse(event.data as string))
        resolve()
      }
    })

    await connected
    ws.close()

    expect(messages[0]).toEqual({ type: 'welcome', agentId: 'test-agent' })
    expect(gateway.isAgentConnected('test-agent')).toBe(true)
  })

  test('assignment is pushed to connected agent', async () => {
    gateway = createGateway({ port: TEST_PORT })
    gateway.start()

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`)
    const messages: unknown[] = []

    const registered = new Promise<void>(resolve => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'register',
          agentId: 'codex',
          name: 'Codex',
          capabilities: ['vote'],
        }))
      }
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as { type: string }
        messages.push(msg)
        if (msg.type === 'welcome') resolve()
      }
    })

    await registered

    const assignmentReceived = new Promise<void>(resolve => {
      ws.onmessage = (event) => {
        messages.push(JSON.parse(event.data as string))
        resolve()
      }
    })

    gateway.assign('codex', {
      id: 'task-1',
      issueId: 'issue-1',
      title: 'RFC-001',
      body: 'Proposal text',
      systemPrompt: 'Review this.',
      createdAt: new Date().toISOString(),
    })

    await assignmentReceived
    ws.close()

    const assignment = messages.find((m: any) => m.type === 'assignment') as any
    expect(assignment.task.id).toBe('task-1')
    expect(assignment.task.title).toBe('RFC-001')
  })

  test('result resolves waitForResult promise', async () => {
    gateway = createGateway({ port: TEST_PORT })
    gateway.start()

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`)

    const registered = new Promise<void>(resolve => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'register',
          agentId: 'codex',
          name: 'Codex',
          capabilities: ['vote'],
        }))
      }
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as { type: string }
        if (msg.type === 'welcome') resolve()
      }
    })

    await registered

    // Listen for assignment then reply with result
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as { type: string; task?: { id: string } }
      if (msg.type === 'assignment' && msg.task) {
        ws.send(JSON.stringify({
          type: 'result',
          taskId: msg.task.id,
          content: 'Looks good. VOTE: APPROVE',
        }))
      }
    }

    gateway.assign('codex', {
      id: 'task-2',
      issueId: 'issue-2',
      title: 'RFC-002',
      body: 'Another proposal',
      systemPrompt: 'Review this.',
      createdAt: new Date().toISOString(),
    })

    const result = await gateway.waitForResult('task-2', 5000)
    ws.close()

    expect(result.taskId).toBe('task-2')
    expect(result.content).toContain('VOTE: APPROVE')
    expect(result.agentId).toBe('codex')
  })

  test('waitForResult times out if no response', async () => {
    gateway = createGateway({ port: TEST_PORT, taskTimeoutMs: 100 })
    gateway.start()

    try {
      await gateway.waitForResult('nonexistent', 100)
      expect(true).toBe(false) // should not reach
    } catch (err) {
      expect((err as Error).message).toContain('timed out')
    }
  })
})

describe('REST fallback', () => {
  test('queued tasks available via REST poll', async () => {
    gateway = createGateway({ port: TEST_PORT })
    gateway.start()

    gateway.assign('offline-agent', {
      id: 'task-3',
      issueId: 'issue-3',
      title: 'RFC-003',
      body: 'Proposal',
      systemPrompt: 'Review.',
      createdAt: new Date().toISOString(),
    })

    const res = await fetch(`http://localhost:${TEST_PORT}/api/agents/offline-agent/tasks`)
    const data = await res.json() as { tasks: { id: string }[] }

    expect(data.tasks.length).toBe(1)
    expect(data.tasks[0]!.id).toBe('task-3')
  })

  test('submit result via REST', async () => {
    gateway = createGateway({ port: TEST_PORT })
    gateway.start()

    const resultPromise = gateway.waitForResult('task-4', 5000)

    // Yield to event loop so the pending entry is registered
    await new Promise(r => setTimeout(r, 10))

    const res = await fetch(`http://localhost:${TEST_PORT}/api/tasks/task-4/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'codex',
        content: 'VOTE: REJECT — needs more detail',
      }),
    })

    expect(res.status).toBe(200)

    const result = await resultPromise
    expect(result.agentId).toBe('codex')
    expect(result.content).toContain('VOTE: REJECT')
  })
})

describe('authentication', () => {
  test('rejects WebSocket upgrade without token', async () => {
    gateway = createGateway({ port: TEST_PORT, token: TEST_TOKEN })
    gateway.start()

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`)

    const rejected = new Promise<boolean>((resolve) => {
      ws.onerror = () => resolve(true)
      ws.onclose = () => resolve(true)
      ws.onopen = () => resolve(false)
    })

    const wasRejected = await rejected
    try { ws.close() } catch {}
    expect(wasRejected).toBe(true)
  })

  test('rejects REST without Bearer token', async () => {
    gateway = createGateway({ port: TEST_PORT, token: TEST_TOKEN })
    gateway.start()

    const res = await fetch(`http://localhost:${TEST_PORT}/api/status`)
    expect(res.status).toBe(401)
  })

  test('accepts REST with valid Bearer token', async () => {
    gateway = createGateway({ port: TEST_PORT, token: TEST_TOKEN })
    gateway.start()

    const res = await fetch(`http://localhost:${TEST_PORT}/api/status`, {
      headers: { 'Authorization': `Bearer ${TEST_TOKEN}` },
    })
    expect(res.status).toBe(200)
  })

  test('accepts WebSocket with valid token query param', async () => {
    gateway = createGateway({ port: TEST_PORT, token: TEST_TOKEN })
    gateway.start()

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?token=${TEST_TOKEN}`)

    const connected = new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'register',
          agentId: 'auth-agent',
          name: 'Auth Agent',
          capabilities: ['vote'],
        }))
      }
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as { type: string }
        if (msg.type === 'welcome') resolve()
        else reject(new Error(`Expected welcome, got ${msg.type}`))
      }
      ws.onerror = () => reject(new Error('WebSocket error'))
    })

    await connected
    ws.close()
    expect(gateway.isAgentConnected('auth-agent')).toBe(true)
  })

  test('no token required when config has no token', async () => {
    gateway = createGateway({ port: TEST_PORT })
    gateway.start()

    const res = await fetch(`http://localhost:${TEST_PORT}/api/status`)
    expect(res.status).toBe(200)
  })
})

describe('message validation', () => {
  test('validates register message', () => {
    expect(validateAgentMessage({ type: 'register', agentId: 'a', name: 'A', capabilities: ['vote'] })).toBe(true)
    expect(validateAgentMessage({ type: 'register', agentId: '', name: 'A', capabilities: [] })).toBe(false)
    expect(validateAgentMessage({ type: 'register', agentId: 'a', name: '', capabilities: [] })).toBe(false)
    expect(validateAgentMessage({ type: 'register' })).toBe(false)
  })

  test('validates result message', () => {
    expect(validateAgentMessage({ type: 'result', taskId: 't1', content: 'VOTE: APPROVE' })).toBe(true)
    expect(validateAgentMessage({ type: 'result', taskId: '', content: '' })).toBe(false)
    expect(validateAgentMessage({ type: 'result' })).toBe(false)
  })

  test('validates heartbeat message', () => {
    expect(validateAgentMessage({ type: 'heartbeat' })).toBe(true)
  })

  test('rejects invalid messages', () => {
    expect(validateAgentMessage(null)).toBe(false)
    expect(validateAgentMessage('string')).toBe(false)
    expect(validateAgentMessage({ type: 'unknown' })).toBe(false)
    expect(validateAgentMessage({})).toBe(false)
  })

  test('server rejects invalid message shape', async () => {
    gateway = createGateway({ port: TEST_PORT })
    gateway.start()

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`)

    const errorReceived = new Promise<string>(resolve => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'register' }))
      }
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as { type: string; message?: string }
        if (msg.type === 'error') resolve(msg.message ?? '')
      }
    })

    const message = await errorReceived
    ws.close()
    expect(message).toBe('Invalid message shape')
  })
})

describe('reconnection / task re-queue', () => {
  test('re-queues in-flight task when agent disconnects', async () => {
    gateway = createGateway({ port: TEST_PORT })
    gateway.start()

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`)

    const registered = new Promise<void>(resolve => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'register',
          agentId: 'flaky',
          name: 'Flaky Agent',
          capabilities: ['vote'],
        }))
      }
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as { type: string }
        if (msg.type === 'welcome') resolve()
      }
    })

    await registered

    // Assign a task (will be in-flight)
    gateway.assign('flaky', {
      id: 'task-requeue',
      issueId: 'issue-rq',
      title: 'Requeue test',
      body: 'Test',
      systemPrompt: 'Review.',
      createdAt: new Date().toISOString(),
    })

    // Wait for assignment to be sent
    await new Promise(r => setTimeout(r, 50))

    // Disconnect — task should be re-queued
    ws.close()
    await new Promise(r => setTimeout(r, 50))

    // Reconnect — should receive the re-queued task
    const ws2 = new WebSocket(`ws://localhost:${TEST_PORT}/ws`)

    const taskReceived = new Promise<string>(resolve => {
      ws2.onopen = () => {
        ws2.send(JSON.stringify({
          type: 'register',
          agentId: 'flaky',
          name: 'Flaky Agent',
          capabilities: ['vote'],
        }))
      }
      ws2.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as { type: string; task?: { id: string } }
        if (msg.type === 'assignment' && msg.task) resolve(msg.task.id)
      }
    })

    const taskId = await taskReceived
    ws2.close()

    expect(taskId).toBe('task-requeue')
  })
})
