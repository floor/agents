import type { LLMAdapter, LLMConfig, LLMResponse, ToolCall, ContentBlock } from '@floor-agents/core'
import { estimateCost } from './pricing.ts'

export type OpenAIAdapterConfig = {
  readonly apiKey?: string
  readonly baseUrl?: string
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const TIMEOUT_MS = 120_000
const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 2000, 4000]

// Well-known local endpoints
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::]']

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return LOCAL_HOSTS.some(h => parsed.hostname === h)
  } catch {
    return false
  }
}

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

export function createOpenAIAdapter(config: OpenAIAdapterConfig = {}): LLMAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const local = isLocalUrl(baseUrl)

  return {
    async run(llmConfig: LLMConfig): Promise<LLMResponse> {
      const start = performance.now()

      // Convert Anthropic-style content blocks to OpenAI message format
      const messages: Record<string, unknown>[] = [
        { role: 'system', content: llmConfig.system },
      ]

      for (const m of llmConfig.messages) {
        if (typeof m.content === 'string') {
          messages.push({ role: m.role, content: m.content })
          continue
        }

        const blocks = m.content as readonly ContentBlock[]

        if (m.role === 'assistant') {
          const textParts: string[] = []
          const toolCallsArr: Record<string, unknown>[] = []

          for (const block of blocks) {
            if (block.type === 'text') textParts.push(block.text)
            else if (block.type === 'tool_use') {
              toolCallsArr.push({
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: JSON.stringify(block.input) },
              })
            }
          }

          const msg: Record<string, unknown> = { role: 'assistant', content: textParts.join('\n') || null }
          if (toolCallsArr.length > 0) msg.tool_calls = toolCallsArr
          messages.push(msg)
        } else if (m.role === 'user') {
          for (const block of blocks) {
            if (block.type === 'tool_result') {
              messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content })
            } else if (block.type === 'text') {
              messages.push({ role: 'user', content: block.text })
            }
          }
        }
      }

      const body: Record<string, unknown> = {
        model: llmConfig.model,
        messages,
        max_tokens: llmConfig.maxTokens ?? 4096,
        temperature: llmConfig.temperature ?? 0,
      }

      // Map tools to OpenAI format
      if (llmConfig.tools?.length) {
        body.tools = llmConfig.tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        }))
      }

      const headers: Record<string, string> = {
        'content-type': 'application/json',
      }

      // API key is optional for local servers (LM Studio, Ollama)
      if (config.apiKey) {
        headers['authorization'] = `Bearer ${config.apiKey}`
      }

      const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`OpenAI-compatible API error ${res.status}: ${text}`)
      }

      const data = await res.json() as any

      const choice = data.choices?.[0]
      const message = choice?.message

      // Extract text content
      const textContent = message?.content ?? ''

      // Extract tool calls (OpenAI format)
      const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc: any) => {
        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {
          input = { _raw: tc.function.arguments }
        }

        return {
          id: tc.id,
          name: tc.function.name,
          input,
        }
      })

      // Map finish_reason
      const finishReason = choice?.finish_reason
      const stopReason = finishReason === 'tool_calls' ? 'tool_use' as const
        : finishReason === 'length' ? 'max_tokens' as const
        : 'end_turn' as const

      const inputTokens = data.usage?.prompt_tokens ?? 0
      const outputTokens = data.usage?.completion_tokens ?? 0

      return {
        content: textContent,
        toolCalls,
        stopReason,
        usage: {
          inputTokens,
          outputTokens,
          cost: estimateCost(llmConfig.model, inputTokens, outputTokens, local),
        },
        provider: local ? 'local' : 'openai',
        model: llmConfig.model,
        durationMs: Math.round(performance.now() - start),
      }
    },
  }
}
