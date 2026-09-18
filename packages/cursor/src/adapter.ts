import type { LLMAdapter, LLMConfig, LLMResponse, ToolCall } from '@floor-agents/core'
import { excerpt, signalGroup, trackChild } from '@floor-agents/core'
import { sandboxed, type SandboxSpec } from '@floor-agents/sandbox'

/**
 * Cursor CLI adapter.
 *
 * `cursor-agent -p` runs a single headless turn against the Cursor subscription,
 * which is why this exists as a separate provider rather than an OpenAI-compatible
 * endpoint: the models are reached through Cursor's account, not through a vendor
 * API key. `provider` names this transport; the model string carries the vendor
 * and family (`cursor-grok-4.6-high`).
 */
export type CursorAdapterConfig = {
  readonly cwd?: string
  readonly model?: string
  /**
   * Allow the agent to run shell commands.
   *
   * The CLI refuses to start in an untrusted directory, so one consent flag is
   * always passed. Measured: `--trust` lets the file-edit tool write — including
   * outside the working directory — while shell commands are refused. `--force`
   * also approves shell commands. Neither flag confines writes: containment comes
   * from `sandbox`, never from the flag.
   */
  readonly allowShell?: boolean
  /** The operating-system sandbox every run starts in. Required: there is no uncontained mode here. */
  readonly sandbox: SandboxSpec
  readonly timeoutMs?: number
  readonly bin?: string
}

const DEFAULT_TIMEOUT_MS = 600_000 // 10 min — a headless turn can run long

/**
 * The envelope `--output-format json` prints: one object on the final line.
 *
 * Note what is absent. Claude Code reports `total_cost_usd`; Cursor reports token
 * counts only, because the run bills against a subscription rather than per call.
 * There is no price to read, so cost is reported as 0 rather than invented.
 */
export type CursorResult = {
  readonly type: string
  readonly subtype: string
  readonly is_error: boolean
  readonly duration_ms: number
  readonly result: string
  readonly session_id?: string
  readonly request_id?: string
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
  }
}

/**
 * Build the argv for one headless turn.
 *
 * Pure, so the flag decisions are testable without spawning anything — the same
 * reason `scripts/lib/grok.ts` splits its argument construction out.
 *
 * `cursor-agent` has no `--cwd`: the working directory is the spawned process's,
 * set by the caller. Passing a directory flag here would silently do nothing.
 */
export function buildCursorArgs(opts: {
  readonly prompt: string
  readonly model?: string
  readonly allowShell?: boolean
}): string[] {
  const args = [
    // Without -p the first positional argument is still treated as a prompt, but
    // interactively: it opens the TUI and never returns. -p is not optional here.
    '-p', opts.prompt,
    '--output-format', 'json',
  ]
  args.push(opts.allowShell ? '--force' : '--trust')
  if (opts.model) args.push('--model', opts.model)
  return args
}

/**
 * Read the envelope.
 *
 * The CLI prints progress before the result, so the JSON is the last non-empty
 * line rather than the whole of stdout.
 */
export function parseCursorResult(stdout: string): CursorResult {
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line) as CursorResult
    } catch {
      // Not the envelope; keep walking back.
    }
  }
  throw new Error(`Cursor returned no JSON result: ${excerpt(stdout)}`)
}

export function createCursorAdapter(config: CursorAdapterConfig): LLMAdapter {
  return {
    async run(llmConfig: LLMConfig): Promise<LLMResponse> {
      const start = performance.now()

      const parts: string[] = []
      if (llmConfig.system) parts.push(llmConfig.system)
      for (const msg of llmConfig.messages) {
        if (typeof msg.content === 'string') parts.push(msg.content)
      }
      const prompt = parts.join('\n')

      const args = buildCursorArgs({
        prompt,
        ...(config.model ? { model: config.model } : {}),
        ...(config.allowShell ? { allowShell: true } : {}),
      })

      // Strip CURSOR_API_KEY so the CLI uses the logged-in subscription rather
      // than metered API auth — the same reason the claude-code adapter strips
      // ANTHROPIC_API_KEY. With the key present the run bills separately.
      const { CURSOR_API_KEY, ...cleanEnv } = process.env

      const proc = Bun.spawn(sandboxed([config.bin ?? 'cursor-agent', ...args], config.sandbox), {
        cwd: config.cwd ?? process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: { ...cleanEnv, CI: 'true' },
        // Its own process group, tracked: a stop of the engine, or this timeout, ends
        // the CLI and whatever it started, not just the wrapper.
        detached: process.platform !== 'win32',
      })
      trackChild(proc, proc.exited)

      const timeoutId = setTimeout(() => signalGroup(proc.pid, 'SIGKILL'), config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]).finally(() => clearTimeout(timeoutId))

      if (exitCode !== 0 && !stdout) {
        throw new Error(`cursor-agent failed (exit ${exitCode}): ${excerpt(stderr)}`)
      }

      const data = parseCursorResult(stdout)
      if (data.is_error) {
        throw new Error(`cursor-agent error: ${data.result || 'unknown error'}`)
      }

      // No tool calls are surfaced: the CLI executes its own tools inside the turn
      // and reports only the final text. A caller that needs to know whether work
      // actually happened must inspect the workspace — see commitWorktree, which
      // returns null when the tree is unchanged. A turn can end having written
      // nothing and still report success, so the text is never the evidence.
      const toolCalls: ToolCall[] = []

      return {
        content: data.result ?? '',
        toolCalls,
        stopReason: 'end_turn',
        usage: {
          inputTokens: data.usage?.inputTokens ?? 0,
          outputTokens: data.usage?.outputTokens ?? 0,
          cost: 0, // subscription-billed; the envelope carries no price
        },
        provider: 'cursor',
        model: config.model ?? 'cursor',
        durationMs: Math.round(performance.now() - start),
      }
    },
  }
}
