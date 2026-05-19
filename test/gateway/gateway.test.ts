import { test, expect, describe, afterEach } from 'bun:test'
import { createGateway, type Gateway } from '@floor-agents/gateway'

let gateway: Gateway | null = null
const TEST_PORT = 9876

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
