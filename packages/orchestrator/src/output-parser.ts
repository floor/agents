import type { LLMResponse, AgentOutput, FileOutput } from '@floor-agents/core'

export function parseToolCallOutput(response: LLMResponse): AgentOutput {
  const files: FileOutput[] = []
  let prTitle = ''
  let prDescription = ''
  const parseErrors: string[] = []

  for (const call of response.toolCalls) {
    if (call.name === 'write_file') {
      const path = call.input.path as string | undefined
      const content = call.input.content as string | undefined

      if (!path || content === undefined) {
        parseErrors.push(`write_file call missing path or content (id: ${call.id})`)
        continue
      }

      files.push({ path: path.trim(), content })
    } else if (call.name === 'pr_description') {
      prTitle = (call.input.title as string) ?? ''
      prDescription = (call.input.description as string) ?? ''
    }
  }

  if (files.length === 0 && parseErrors.length === 0) {
    parseErrors.push('No write_file tool calls in response')
  }

  const description = prDescription
    || prTitle
    || response.content.slice(0, 500)

  return {
    rawResponse: response.content,
    files,
    prDescription: description,
    parseErrors,
  }
}
