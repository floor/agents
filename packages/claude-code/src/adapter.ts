import type { LLMAdapter, LLMConfig, LLMResponse, ToolCall } from '@floor-agents/core'

export type ClaudeCodeAdapterConfig = {
  readonly cwd?: string
  readonly model?: string
  readonly maxTurns?: number
  readonly allowedTools?: string[]
}

const DEFAULT_MAX_TURNS = 10
const TIMEOUT_MS = 600_000 // 10 min — Claude Code can take a while

type ClaudeCodeResult = {
  type: string
  subtype: string
  is_error: boolean
  duration_ms: number
  result: string
  total_cost_usd: number
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

export function createClaudeCodeAdapter(config: ClaudeCodeAdapterConfig = {}): LLMAdapter {
  return {
    async run(llmConfig: LLMConfig): Promise<LLMResponse> {
      const start = performance.now()

      // Build the prompt: system + messages combined
      const parts: string[] = []

      if (llmConfig.system) {
        parts.push(llmConfig.system)
      }

      for (const msg of llmConfig.messages) {
        if (typeof msg.content === 'string') {
          parts.push(msg.content)
        }
      }

      // If tools are defined, instruct Claude Code to respond with JSON tool calls
      if (llmConfig.tools?.length) {
        parts.push('')
        parts.push('IMPORTANT: Respond with a JSON object containing your tool calls.')
        parts.push('Use this exact format:')
        parts.push('```json')
        parts.push(JSON.stringify({
          tool_calls: llmConfig.tools.map(t => ({
            name: t.name,
            input: Object.fromEntries(
              Object.entries((t.inputSchema as any).properties ?? {}).map(([k]) => [k, `<${k}>`])
            ),
          })),
        }, null, 2))
        parts.push('```')
      }

      const prompt = parts.join('\n')

      // Build claude CLI args
      const args = [
        'claude',
        '-p', prompt,
        '--output-format', 'json',
        '--max-turns', String(config.maxTurns ?? DEFAULT_MAX_TURNS),
      ]

      if (config.model) {
        args.push('--model', config.model)
      }

      if (config.allowedTools?.length) {
        args.push('--allowedTools', config.allowedTools.join(','))
      }

      const proc = Bun.spawn(args, {
        cwd: config.cwd ?? process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          // Ensure non-interactive mode
          CI: 'true',
        },
      })

      // Set up timeout
      const timeoutId = setTimeout(() => proc.kill(), TIMEOUT_MS)

      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited

      clearTimeout(timeoutId)

      if (exitCode !== 0 && !stdout) {
        throw new Error(`Claude Code failed (exit ${exitCode}): ${stderr}`)
      }

      // Parse the JSON output
      let data: ClaudeCodeResult
      try {
        data = JSON.parse(stdout)
      } catch {
        throw new Error(`Claude Code returned invalid JSON: ${stdout.slice(0, 500)}`)
      }

      if (data.is_error) {
        throw new Error(`Claude Code error: ${data.result}`)
      }

      // Extract tool calls from the response if tools were defined
      const toolCalls: ToolCall[] = []

      if (llmConfig.tools?.length) {
        // Try to extract JSON tool calls from the response
        const jsonMatch = data.result.match(/```json\s*([\s\S]*?)```/)
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]!)
            const calls = parsed.tool_calls ?? parsed.toolCalls ?? [parsed]
            for (const call of Array.isArray(calls) ? calls : [calls]) {
              if (call.name) {
                toolCalls.push({
                  id: `cc-${Math.random().toString(36).slice(2)}`,
                  name: call.name,
                  input: call.input ?? call.arguments ?? {},
                })
              }
            }
          } catch {}
        }

        // Also try to parse the whole response as JSON
        if (toolCalls.length === 0) {
          try {
            const parsed = JSON.parse(data.result)
            const calls = parsed.tool_calls ?? parsed.toolCalls ?? [parsed]
            for (const call of Array.isArray(calls) ? calls : [calls]) {
              if (call.name) {
                toolCalls.push({
                  id: `cc-${Math.random().toString(36).slice(2)}`,
                  name: call.name,
                  input: call.input ?? call.arguments ?? {},
                })
              }
            }
          } catch {}
        }
      }

      return {
        content: data.result,
        toolCalls,
        stopReason: 'end_turn',
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
          cost: data.total_cost_usd ?? 0,
        },
        provider: 'claude-code',
        model: config.model ?? 'claude-code',
        durationMs: Math.round(performance.now() - start),
      }
    },
  }
}
