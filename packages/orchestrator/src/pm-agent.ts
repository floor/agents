import type {
  AgentDefinition,
  Issue,
  TaskAdapter,
  LLMAdapter,
  ToolDefinition,
  ToolCall,
  ContentBlock,
} from '@floor-agents/core'

const PM_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_subtask',
    description: 'Create a concrete engineering sub-task for this issue. Call once per sub-task.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short, actionable title for the sub-task (imperative mood)',
        },
        description: {
          type: 'string',
          description:
            'Full description: what to implement, acceptance criteria, and relevant context',
        },
        agentLabel: {
          type: 'string',
          enum: ['backend', 'frontend'],
          description:
            'Which development agent handles this sub-task: backend (API, services, DB, tests) or frontend (UI, components, styles)',
        },
      },
      required: ['title', 'description', 'agentLabel'],
    },
  },
  {
    name: 'subtasks_done',
    description: 'Signal that all sub-tasks have been created. Call exactly once at the end.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of the decomposition and overall implementation approach',
        },
      },
      required: ['summary'],
    },
  },
]

export type PMAgentResult = {
  readonly subtaskIds: readonly string[]
  readonly costUsd: number
}

export type PMAgentDeps = {
  readonly taskAdapter: TaskAdapter
  readonly llmAdapters: ReadonlyMap<string, LLMAdapter>
}

export async function runPMAgent(
  issue: Issue,
  agent: AgentDefinition,
  deps: PMAgentDeps,
): Promise<PMAgentResult> {
  const { taskAdapter, llmAdapters } = deps
  const llm = llmAdapters.get(agent.llm.provider)
  if (!llm) throw new Error(`No LLM adapter for provider: ${agent.llm.provider}`)

  let rolePrompt = 'You are a technical project manager.'
  try {
    const file = Bun.file(agent.promptTemplate)
    if (await file.exists()) rolePrompt = await file.text()
  } catch {}

  const systemPrompt = [
    rolePrompt,
    '',
    '## Your Job',
    'Analyze the given issue and decompose it into concrete, independently-executable engineering sub-tasks.',
    'Each sub-task should be self-contained — a developer should be able to implement it without relying on other sub-tasks being done first.',
    'Label each sub-task as "backend" (API, database, services, tests) or "frontend" (UI, components, styles).',
    'If the work spans both areas, create separate sub-tasks for each.',
    '',
    '## Output',
    'Call `create_subtask` once for each sub-task you identify.',
    'Call `subtasks_done` exactly once at the end to signal you are finished.',
  ].join('\n')

  const userMessage = [
    `## Issue: ${issue.title}`,
    '',
    issue.body || 'No description provided.',
    '',
    'Please decompose this issue into concrete engineering sub-tasks.',
  ].join('\n')

  // Run the tool-use loop
  const allToolCalls: ToolCall[] = []
  let totalCost = 0
  const conversation: Array<{
    role: 'user' | 'assistant'
    content: string | readonly ContentBlock[]
  }> = [{ role: 'user', content: userMessage }]

  while (true) {
    const response = await llm.run({
      provider: agent.llm.provider,
      model: agent.llm.model,
      system: systemPrompt,
      messages: conversation,
      tools: PM_TOOLS,
      maxTokens: agent.llm.maxTokens,
      temperature: agent.llm.temperature,
    })

    totalCost += response.usage.cost
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

    const resultBlocks: ContentBlock[] = response.toolCalls.map(tc => ({
      type: 'tool_result' as const,
      tool_use_id: tc.id,
      content: 'ok',
    }))
    conversation.push({ role: 'user', content: resultBlocks })
  }

  // Create sub-issues from `create_subtask` tool calls
  const subtaskIds: string[] = []
  for (const tc of allToolCalls) {
    if (tc.name !== 'create_subtask') continue

    const { title, description, agentLabel } = tc.input as {
      title: string
      description: string
      agentLabel: string
    }

    const subtask = await taskAdapter.createIssue(
      {
        title,
        body: description,
        labels: [agentLabel, 'agent'],
        status: 'in_progress',
      },
      issue.id,
    )
    subtaskIds.push(subtask.id)
  }

  return { subtaskIds, costUsd: totalCost }
}
