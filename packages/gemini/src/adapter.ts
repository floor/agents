import type { LLMAdapter, LLMConfig, LLMResponse, ToolCall, ContentBlock } from '@floor-agents/core'

export type GeminiProviderConfig = {
  readonly apiKey: string
}

const DEFAULT_MODEL = 'gemini-2.5-flash'

// Pricing structure based on model family
const PRICING = {
  'gemini-2.5-pro': { input: 1.25, output: 10 }, // $1.25/M input, $10/M output
  'gemini-2.5-flash': { input: 0.15, output: 60 }, // $0.15/M input, $0.60/M output
}

export function createGeminiAdapter(config: GeminiProviderConfig): LLMAdapter {
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + DEFAULT_MODEL + ':generateContent'

  return {
    async run(llmConfig: LLMConfig): Promise<LLMResponse> {
      const start = performance.now()

      // --- 1. Convert messages to Gemini format ---
      const geminiMessages: any[] = []

      for (const m of llmConfig.messages) {
        if (typeof m.content === 'string') {
          geminiMessages.push({ role: m.role, parts: [{ text: m.content }] })
          continue
        }

        // Content is an array of blocks (Anthropic style) -> Gemini parts
        const parts: any[] = []
        for (const block of m.content as readonly ContentBlock[]) {
          if (block.type === 'text') {
            parts.push({ text: block.text })
          } else if (block.type === 'tool_use') {
            // Map tool_use to functionCall structure for Gemini
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input,
              }
            })
          } else if (block.type === 'tool_result') {
            // Tool results are handled separately in the response parsing phase, not directly in input messages
            // We skip adding tool_result blocks to the input message stream for now, as Gemini handles them via function calls/responses structure.
          }
        }

        if (parts.length > 0) {
          geminiMessages.push({ role: m.role, parts: parts })
        }
      }

      // --- 2. Prepare tools for Gemini API ---
      const functionDeclarations: any[] = []
      if (llmConfig.tools?.length) {
        llmConfig.tools.forEach(t => {
          functionDeclarations.push({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })
        })
      }

      // --- 3. Prepare API call body ---
      const model = llmConfig.model || DEFAULT_MODEL
      const pricingInfo = PRICING[model] || PRICING['gemini-2.5-flash']

      const body: any = {
        contents: geminiMessages,
        tools: functionDeclarations,
        config: {
          temperature: llmConfig.temperature ?? 0,
        }
      }

      // --- 4. Make API Call ---
      const response = await fetch(baseUrl, {
        method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Gemini API error ${response.status}: ${errorText}`)
      }

      const data = await response.json() as any

      // --- 5. Parse Response ---
      const responseContent = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      const toolCalls: any[] = []

      if (data.candidates?.[0]?.content?.parts?.[0]?.functionCall) {
        // Gemini returns functionCall directly in the content part if it's a tool use request
        const fc = data.candidates[0].content.parts[0].functionCall
        toolCalls.push({
          id: fc.name, // Use function name as ID for simplicity, though Gemini usually provides structured response IDs
          name: fc.name,
          input: fc.args,
        })
      }

      const finishReason = data.candidates?.[0]?.finishReason
      let stopReason = 'end_turn'

      if (finishReason === 'tool_calls') {
        stopReason = 'tool_use'
      } else if (finishReason === 'length') {
        stopReason = 'max_tokens'
      }

      const usage = data.usage
      const cost = calculateCost(model, usage)

      return {
        content: responseContent,
        toolCalls: toolCalls,
        stopReason: stopReason,
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.candidates_token_count ?? 0, // Use candidate token count for output tokens if available
          cost: cost,
        },
        provider: 'gemini',
        model: data.candidates?.[0]?.content?.parts?.[0]?.functionCall?.name || model,
        durationMs: Math.round(performance.now() - start),
      }
    },
  }
}

function calculateCost(model: string, usage: { prompt_tokens: number, candidates_token_count: number }): number {
  const modelName = model.includes('pro') ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
  const pricingInfo = PRICING[modelName] || PRICING['gemini-2.5-flash']

  // Cost calculation based on input/output tokens
  const inputCost = usage.prompt_tokens * pricingInfo.input
  const outputCost = usage.candidates_token_count * pricingInfo.output
  return inputCost + outputCost
}