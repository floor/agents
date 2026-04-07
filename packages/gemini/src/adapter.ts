import type { LLMAdapter, LLMConfig, LLMResponse, ToolCall, ContentBlock } from '@floor-agents/core'

export type GeminiAdapterConfig = {
  readonly apiKey: string
}

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const TIMEOUT_MS = 120_000
const MAX_RETRIES = 2
const RETRY_DELAYS = [2000, 5000]

// Pricing per million tokens (USD)
const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Match on prefix so variants like gemini-2.5-pro-preview also resolve
  const key = Object.keys(PRICING).find(k => model.startsWith(k))
  if (!key) return 0
  const { input, output } = PRICING[key]!
  return (inputTokens / 1_000_000) * input + (outputTokens / 1_000_000) * output
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

// Convert a single Anthropic ContentBlock[] message to Gemini parts
function contentBlocksToGeminiParts(blocks: readonly ContentBlock[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ text: block.text })
    } else if (block.type === 'tool_use') {
      parts.push({
        functionCall: {
          name: block.name,
          args: block.input,
        },
      })
    } else if (block.type === 'tool_result') {
      parts.push({
        functionResponse: {
          name: '', // Gemini requires name; resolved below via tool_use_id lookup
          response: { output: block.content },
        },
      })
    }
  }

  return parts
}

export function createGeminiAdapter(config: GeminiAdapterConfig): LLMAdapter {
  return {
    async run(llmConfig: LLMConfig): Promise<LLMResponse> {
      const start = performance.now()

      // Build a lookup of tool_use id -> name for resolving functionResponse names
      const toolUseNames = new Map<string, string>()
      for (const m of llmConfig.messages) {
        if (m.role === 'assistant' && Array.isArray(m.content)) {
          for (const block of m.content as readonly ContentBlock[]) {
            if (block.type === 'tool_use') {
              toolUseNames.set(block.id, block.name)
            }
          }
        }
      }

      // Convert messages to Gemini contents format
      const contents: Record<string, unknown>[] = []

      for (const m of llmConfig.messages) {
        // Gemini uses 'user' and 'model' roles
        const role = m.role === 'assistant' ? 'model' : 'user'

        if (typeof m.content === 'string') {
          contents.push({ role, parts: [{ text: m.content }] })
          continue
        }

        const blocks = m.content as readonly ContentBlock[]

        if (m.role === 'user') {
          // Split tool_result blocks (functionResponse) into their own turn,
          // and text blocks into user turns. Gemini expects a single turn per
          // role so we group them all into one user message.
          const parts: Record<string, unknown>[] = []

          for (const block of blocks) {
            if (block.type === 'tool_result') {
              parts.push({
                functionResponse: {
                  name: toolUseNames.get(block.tool_use_id) ?? block.tool_use_id,
                  response: { output: block.content },
                },
              })
            } else if (block.type === 'text') {
              parts.push({ text: block.text })
            }
          }

          if (parts.length > 0) contents.push({ role: 'user', parts })
        } else {
          // Assistant message: text + functionCall parts
          const parts = contentBlocksToGeminiParts(blocks)
          if (parts.length > 0) contents.push({ role: 'model', parts })
        }
      }

      // Build request body
      const body: Record<string, unknown> = {
        systemInstruction: {
          parts: [{ text: llmConfig.system }],
        },
        contents,
        generationConfig: {
          maxOutputTokens: llmConfig.maxTokens ?? 8192,
          temperature: llmConfig.temperature ?? 0,
        },
      }

      if (llmConfig.tools?.length) {
        body.tools = [
          {
            functionDeclarations: llmConfig.tools.map(t => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            })),
          },
        ]
      }

      const url = `${BASE_URL}/${llmConfig.model}:generateContent?key=${config.apiKey}`

      const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Gemini error ${res.status}: ${text}`)
      }

      const data = await res.json() as any

      const candidate = data.candidates?.[0]
      const parts: any[] = candidate?.content?.parts ?? []

      let textContent = ''
      const toolCalls: ToolCall[] = []

      for (const part of parts) {
        if (part.text !== undefined) {
          textContent += part.text
        } else if (part.functionCall) {
          toolCalls.push({
            id: `fc-${Math.random().toString(36).slice(2)}`,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
          })
        }
      }

      const finishReason: string = candidate?.finishReason ?? 'STOP'
      const stopReason =
        finishReason === 'MAX_TOKENS' ? 'max_tokens' as const
        : toolCalls.length > 0 ? 'tool_use' as const
        : 'end_turn' as const

      const inputTokens: number = data.usageMetadata?.promptTokenCount ?? 0
      const outputTokens: number = data.usageMetadata?.candidatesTokenCount ?? 0

      return {
        content: textContent,
        toolCalls,
        stopReason,
        usage: {
          inputTokens,
          outputTokens,
          cost: estimateCost(llmConfig.model, inputTokens, outputTokens),
        },
        provider: 'gemini',
        model: llmConfig.model,
        durationMs: Math.round(performance.now() - start),
      }
    },
  }
}
