import type { LLMAdapter, LLMConfig, LLMMessage, LLMResponse, ToolCall, ContentBlock } from '@floor-agents/core'

export type LMStudioAdapterConfig = {
  readonly baseUrl?: string
  readonly apiKey?: string
}

const DEFAULT_BASE_URL = 'http://localhost:1234/v1'
const TIMEOUT_MS = 300_000 // 5 min — local models can be slow
const MAX_RETRIES = 2
const RETRY_DELAYS = [2000, 5000]

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

export function createLMStudioAdapter(config: LMStudioAdapterConfig = {}): LLMAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL

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

        // Content is an array of blocks — convert to OpenAI format
        const blocks = m.content as readonly ContentBlock[]

        if (m.role === 'assistant') {
          // Assistant message with tool_use blocks → OpenAI tool_calls format
          const textParts: string[] = []
          const toolCalls: Record<string, unknown>[] = []

          for (const block of blocks) {
            if (block.type === 'text') {
              textParts.push(block.text)
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                },
              })
            }
          }

          const msg: Record<string, unknown> = {
            role: 'assistant',
            content: textParts.join('\n') || null,
          }
          if (toolCalls.length > 0) msg.tool_calls = toolCalls
          messages.push(msg)
        } else if (m.role === 'user') {
          // User message with tool_result blocks → OpenAI role: "tool" messages
          for (const block of blocks) {
            if (block.type === 'tool_result') {
              messages.push({
                role: 'tool',
                tool_call_id: block.tool_use_id,
                content: block.content,
              })
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
        throw new Error(`LM Studio error ${res.status}: ${text}`)
      }

      const data = await res.json() as any

      const choice = data.choices?.[0]
      const message = choice?.message

      const textContent = message?.content ?? ''

      const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc: any) => {
        let input: Record<string, unknown> = {}
        try {
          input = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments
        } catch {
          input = { _raw: tc.function.arguments }
        }

        return {
          id: tc.id ?? `tc-${Math.random().toString(36).slice(2)}`,
          name: tc.function.name,
          input,
        }
      })

      const finishReason = choice?.finish_reason
      const stopReason = finishReason === 'tool_calls' ? 'tool_use' as const
        : finishReason === 'length' ? 'max_tokens' as const
        : 'end_turn' as const

      return {
        content: textContent,
        toolCalls,
        stopReason,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          cost: 0, // Local models are free
        },
        provider: 'lmstudio',
        model: data.model ?? llmConfig.model,
        durationMs: Math.round(performance.now() - start),
      }
    },
  }
}
