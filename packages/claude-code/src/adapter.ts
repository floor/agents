import type { LLMAdapter, LLMConfig, LLMResponse, ToolCall } from '@floor-agents/core'
import { excerpt } from '@floor-agents/core'
import { sandboxed, type SandboxSpec } from '@floor-agents/sandbox'

export type ClaudeCodeAdapterConfig = {
  readonly cwd?: string
  readonly model?: string
  readonly maxTurns?: number
  readonly allowedTools?: string[]
  /**
   * The operating-system sandbox the CLI starts in. With `Bash` in allowedTools
   * the agent can write anywhere the user can; a sandbox is what stops it.
   * Committee reviewers pass `reviewerSandbox('claude')`.
   */
  readonly sandbox?: SandboxSpec
}

/**
 * Generic default for one `claude -p` turn. Committee PR review passes the
 * native reviewer's cap (`DEFAULT_MAX_TURNS.review`, 60) per call so a
 * member that starts reading the repository does not die here with no final
 * text. The adapter itself stays at 10: a PM or RFC caller does not inherit
 * the reviewer's budget.
 */
const DEFAULT_MAX_TURNS = 10
const TIMEOUT_MS = 600_000 // 10 min — Claude Code can take a while

export type ClaudeCodeResult = {
  type?: string
  subtype?: string
  is_error?: boolean
  duration_ms?: number
  result?: string
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

/**
 * The argv for one `claude -p` turn. Pure, so the turn cap is testable without
 * spawning anything — the same reason `buildCursorArgs` splits construction out.
 */
export function buildClaudeCodeArgs(opts: {
  readonly prompt: string
  readonly maxTurns?: number
  readonly model?: string
  readonly allowedTools?: readonly string[]
}): string[] {
  const args = [
    'claude',
    '-p', opts.prompt,
    '--output-format', 'json',
    '--max-turns', String(opts.maxTurns ?? DEFAULT_MAX_TURNS),
  ]
  if (opts.model) args.push('--model', opts.model)
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','))
  return args
}

/** Last characters of `result` kept in a thrown error — GitHub rejects PR comments over ~64 KiB (HTTP 422). */
const ERROR_RESULT_TAIL = 2_000
/** Last characters of stderr that travel with the error so the abstention comment has a trace. */
const ERROR_STDERR_TAIL = 500

/**
 * The message a committee abstention shows. `subtype` is the envelope's own
 * reason (`error_max_turns`, `error_during_execution`); without it the
 * comment used to read `Unknown error`. `result` is capped so a long partial
 * turn cannot 422 the PR comment; stderr's last 500 characters travel with
 * it so the trace is on the PR.
 */
export function formatClaudeCodeError(
  data: Pick<ClaudeCodeResult, 'subtype' | 'result'>,
  stderr: string,
): string {
  const subtype = data.subtype ? ` (${data.subtype})` : ''
  const result = (data.result || 'Unknown error').slice(-ERROR_RESULT_TAIL)
  const tail = stderr.trim().slice(-ERROR_STDERR_TAIL)
  return tail
    ? `Claude Code error${subtype}: ${result}\n${tail}`
    : `Claude Code error${subtype}: ${result}`
}

/**
 * What one envelope becomes. `is_error` always fails — including
 * `error_max_turns` that still produced text. A truncated `VOTE: APPROVE`
 * must not count as a completed review; the thrown message carries
 * `subtype`, `result`, and stderr so the committee comment can say why.
 */
export function interpretClaudeCodeTurn(data: ClaudeCodeResult, stderr: string): string {
  if (data.is_error) {
    throw new Error(formatClaudeCodeError(data, stderr))
  }
  return data.result ?? ''
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
              Object.entries((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).map(([k]) => [k, `<${k}>`])
            ),
          })),
        }, null, 2))
        parts.push('```')
      }

      const prompt = parts.join('\n')

      const args = buildClaudeCodeArgs({
        prompt,
        maxTurns: llmConfig.maxTurns ?? config.maxTurns,
        ...(config.model ? { model: config.model } : {}),
        ...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
      })

      // Strip API keys from env so Claude Code uses the Max plan subscription,
      // not the Anthropic API. If ANTHROPIC_API_KEY is present, Claude Code
      // routes through the API and charges per token instead of using the plan.
      const { ANTHROPIC_API_KEY, ...cleanEnv } = process.env

      const proc = Bun.spawn(config.sandbox ? sandboxed(args, config.sandbox) : args, {
        cwd: config.cwd ?? process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...cleanEnv,
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
        throw new Error(`Claude Code returned invalid JSON: ${excerpt(stdout)}`)
      }

      const resultText = interpretClaudeCodeTurn(data, stderr)

      // Extract tool calls from the response if tools were defined
      const toolCalls: ToolCall[] = []

      if (llmConfig.tools?.length) {
        // Try to extract JSON tool calls from the response
        const jsonMatch = resultText.match(/```json\s*([\s\S]*?)```/)
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
            const parsed = JSON.parse(resultText)
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
        content: resultText,
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
