import type { LLMAdapter, LLMConfig, LLMResponse, ToolCall } from '@floor-agents/core'
import { estimateCost } from './pricing.ts'

export type AnthropicAdapterConfig = {
  readonly apiKey: string
  readonly baseUrl?: string
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'
const TIMEOUT_MS = 120_000
const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 2000, 4000]
const OVERLOADED_DELAY = 10_000

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const res = await fetch(url, { ...init, signal: controller.signal })

      if (res.status === 529 && attempt < retries) {
        await new Promise(r => setTimeout(r, OVERLOADED_DELAY))
        continue
      }

      if (res.status === 429 && attempt < retries) {
        const retryAfter = res.headers.get('retry-after')
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : RETRY_DELAYS[attempt]!
        await new Promise(r => setTimeout(r, delay))
        continue
      }

      if (!res.ok && res.status >= 500 && attempt < retries) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]!))
        continue
      }

      return res
    } catch (err) {
      if (attempt === retries) throw err
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]!))
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error('Max retries exceeded')
}

export function createAnthropicAdapter(config: AnthropicAdapterConfig): LLMAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL

  return {
    async run(llmConfig: LLMConfig): Promise<LLMResponse> {
      const start = performance.now()

      const body: Record<string, unknown> = {
        model: llmConfig.model,
        max_tokens: llmConfig.maxTokens ?? 4096,
        temperature: llmConfig.temperature ?? 0,
        system: llmConfig.system,
        messages: llmConfig.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      }

      if (llmConfig.tools?.length) {
        body.tools = llmConfig.tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }))
      }

      const res = await fetchWithRetry(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Anthropic API error ${res.status}: ${text}`)
      }

      const data = await res.json() as any

      // Extract text content and tool calls from response
      let textContent = ''
      const toolCalls: ToolCall[] = []

      for (const block of data.content ?? []) {
        if (block.type === 'text') {
          textContent += block.text
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
          })
        }
      }

      const inputTokens = data.usage?.input_tokens ?? 0
      const outputTokens = data.usage?.output_tokens ?? 0

      return {
        content: textContent,
        toolCalls,
        stopReason: data.stop_reason === 'tool_use' ? 'tool_use'
          : data.stop_reason === 'max_tokens' ? 'max_tokens'
          : 'end_turn',
        usage: {
          inputTokens,
          outputTokens,
          cost: estimateCost(llmConfig.model, inputTokens, outputTokens),
        },
        provider: 'anthropic',
        model: llmConfig.model,
        durationMs: Math.round(performance.now() - start),
      }
    },
  }
}
