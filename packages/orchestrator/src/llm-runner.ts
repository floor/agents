import type {
  LLMAdapter,
  LLMMessage,
  ContentBlock,
  AgentDefinition,
  ToolCall,
  ToolDefinition,
} from '@floor-agents/core'

export type LLMRunResult = {
  readonly toolCalls: ToolCall[]
  readonly content: string
  readonly totalCost: number
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly durationMs: number
}

export type LLMAdapterResolver = (provider: string) => LLMAdapter

export async function runToolUseLoop(
  agent: AgentDefinition,
  systemPrompt: string,
  messages: LLMMessage[],
  tools: readonly ToolDefinition[],
  getAdapter: LLMAdapterResolver,
  toolHandler?: (tc: ToolCall) => Promise<string>,
): Promise<LLMRunResult> {
  const llm = getAdapter(agent.llm.provider)
  const allToolCalls: ToolCall[] = []
  let content = ''
  let totalCost = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalDurationMs = 0
  const conversation = [...messages]

  while (true) {
    const response = await llm.run({
      provider: agent.llm.provider,
      model: agent.llm.model,
      system: systemPrompt,
      messages: conversation,
      tools,
      maxTokens: agent.llm.maxTokens,
      temperature: agent.llm.temperature,
    })

    content += response.content
    totalCost += response.usage.cost
    totalInputTokens += response.usage.inputTokens
    totalOutputTokens += response.usage.outputTokens
    totalDurationMs += response.durationMs

    if (response.toolCalls.length > 0) {
      allToolCalls.push(...response.toolCalls)
    }

    if (response.stopReason !== 'tool_use') break

    const assistantBlocks: ContentBlock[] = []
    if (response.content) {
      assistantBlocks.push({ type: 'text', text: response.content })
    }
    for (const tc of response.toolCalls) {
      assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
    }
    conversation.push({ role: 'assistant', content: assistantBlocks })

    const resultBlocks: ContentBlock[] = await Promise.all(
      response.toolCalls.map(async tc => ({
        type: 'tool_result' as const,
        tool_use_id: tc.id,
        content: toolHandler ? await toolHandler(tc) : 'ok',
      })),
    )
    conversation.push({ role: 'user', content: resultBlocks })
  }

  return { toolCalls: allToolCalls, content, totalCost, totalInputTokens, totalOutputTokens, durationMs: totalDurationMs }
}
