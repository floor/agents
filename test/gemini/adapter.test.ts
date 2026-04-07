// @ts-nocheck — fetch mock types don't match Bun's fetch signature
import { test, expect, mock } from 'bun:test'
import { createGeminiAdapter } from '@floor-agents/gemini'
import type { LLMConfig } from '@floor-agents/core'

const BASE_CONFIG: LLMConfig = {
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'Hello' }],
}

test('creates adapter', () => {
  const adapter = createGeminiAdapter({ apiKey: 'test-key' })
  expect(typeof adapter.run).toBe('function')
})

test('sends correct request format', async () => {
  const calls: { url: string; body: unknown }[] = []

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body as string) })
    return new Response(
      JSON.stringify({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'Hi there!' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  try {
    const adapter = createGeminiAdapter({ apiKey: 'my-api-key' })
    await adapter.run(BASE_CONFIG)

    expect(calls).toHaveLength(1)
    const { url, body } = calls[0]!

    expect(url).toContain('gemini-2.5-flash:generateContent')
    expect(url).toContain('key=my-api-key')

    const b = body as any
    expect(b.systemInstruction.parts[0].text).toBe('You are a helpful assistant.')
    expect(b.contents).toHaveLength(1)
    expect(b.contents[0].role).toBe('user')
    expect(b.contents[0].parts[0].text).toBe('Hello')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('parses text response', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'Hello back!' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  try {
    const adapter = createGeminiAdapter({ apiKey: 'test' })
    const result = await adapter.run(BASE_CONFIG)

    expect(result.content).toBe('Hello back!')
    expect(result.toolCalls).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.provider).toBe('gemini')
    expect(result.model).toBe('gemini-2.5-flash')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(4)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('parses function call response', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              functionCall: {
                name: 'write_file',
                args: { path: 'foo.ts', content: 'hello' },
              },
            }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  try {
    const adapter = createGeminiAdapter({ apiKey: 'test' })
    const result = await adapter.run({
      ...BASE_CONFIG,
      tools: [{
        name: 'write_file',
        description: 'Write a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      }],
    })

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]!.name).toBe('write_file')
    expect(result.toolCalls[0]!.input).toEqual({ path: 'foo.ts', content: 'hello' })
    expect(result.stopReason).toBe('tool_use')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sends tools in functionDeclarations format', async () => {
  const calls: any[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(init?.body as string))
    return new Response(
      JSON.stringify({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  try {
    const adapter = createGeminiAdapter({ apiKey: 'test' })
    await adapter.run({
      ...BASE_CONFIG,
      tools: [{
        name: 'search',
        description: 'Search the web',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      }],
    })

    const body = calls[0]
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].functionDeclarations).toHaveLength(1)
    expect(body.tools[0].functionDeclarations[0].name).toBe('search')
    expect(body.tools[0].functionDeclarations[0].description).toBe('Search the web')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('handles MAX_TOKENS finish reason', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'partial...' }] },
          finishReason: 'MAX_TOKENS',
        }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 8192 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  try {
    const adapter = createGeminiAdapter({ apiKey: 'test' })
    const result = await adapter.run(BASE_CONFIG)
    expect(result.stopReason).toBe('max_tokens')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('estimates cost for gemini-2.5-pro', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  try {
    const adapter = createGeminiAdapter({ apiKey: 'test' })
    const result = await adapter.run({ ...BASE_CONFIG, model: 'gemini-2.5-pro' })
    // 1M input @ $1.25 + 1M output @ $10.00 = $11.25
    expect(result.usage.cost).toBeCloseTo(11.25)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('estimates cost for gemini-2.5-flash', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  try {
    const adapter = createGeminiAdapter({ apiKey: 'test' })
    const result = await adapter.run(BASE_CONFIG)
    // 1M input @ $0.15 + 1M output @ $0.60 = $0.75
    expect(result.usage.cost).toBeCloseTo(0.75)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('converts multi-turn tool use messages', async () => {
  const calls: any[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(init?.body as string))
    return new Response(
      JSON.stringify({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'done' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  try {
    const adapter = createGeminiAdapter({ apiKey: 'test' })
    await adapter.run({
      ...BASE_CONFIG,
      messages: [
        { role: 'user', content: 'Search for something' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Searching now.' },
            { type: 'tool_use', id: 'tc-1', name: 'search', input: { query: 'bun runtime' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tc-1', content: 'Bun is a fast JS runtime.' },
          ],
        },
      ],
    })

    const { contents } = calls[0]
    // user, model, user
    expect(contents).toHaveLength(3)

    // model turn has text + functionCall
    const modelTurn = contents[1]
    expect(modelTurn.role).toBe('model')
    expect(modelTurn.parts[0].text).toBe('Searching now.')
    expect(modelTurn.parts[1].functionCall.name).toBe('search')
    expect(modelTurn.parts[1].functionCall.args).toEqual({ query: 'bun runtime' })

    // user turn with functionResponse
    const resultTurn = contents[2]
    expect(resultTurn.role).toBe('user')
    expect(resultTurn.parts[0].functionResponse.name).toBe('search')
    expect(resultTurn.parts[0].functionResponse.response.output).toBe('Bun is a fast JS runtime.')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('throws on non-ok response', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('Bad Request', { status: 400 })

  try {
    const adapter = createGeminiAdapter({ apiKey: 'bad-key' })
    await expect(adapter.run(BASE_CONFIG)).rejects.toThrow('Gemini error 400')
  } finally {
    globalThis.fetch = originalFetch
  }
})
