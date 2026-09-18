import type { LLMAdapter, LLMConfig, LLMResponse, ToolCall } from '@floor-agents/core'
import { excerpt } from '@floor-agents/core'
import { sandboxed, type SandboxSpec } from '@floor-agents/sandbox'

/**
 * Antigravity CLI adapter.
 *
 * `agy -p` runs a single headless turn against the Google account's AI Pro
 * subscription, which is why this exists as a separate provider rather than the
 * Gemini API adapter: the models are reached through that login, not through a
 * vendor API key. `provider: antigravity` names this transport; `provider: gemini`
 * stays the metered API. The model string is what `agy models` lists
 * (`gemini-3.1-pro-high`).
 */
export type AgyRole = 'implement' | 'review'
export type AgyEffort = 'low' | 'medium' | 'high'

export type AntigravityAdapterConfig = {
  readonly cwd?: string
  readonly model?: string
  /**
   * Whether this turn may edit. A reviewer runs `--mode plan` (read-only). An
   * implementer runs `--dangerously-skip-permissions` so it can edit and run
   * tests without prompting. Neither flag confines writes: containment comes
   * from `sandbox`, never from the flag. `--sandbox` on agy itself is its own
   * mechanism and is not relied on here.
   */
  readonly role?: AgyRole
  readonly effort?: AgyEffort
  /** The operating-system sandbox every run starts in. Required: there is no uncontained mode here. */
  readonly sandbox: SandboxSpec
  readonly timeoutMs?: number
  readonly bin?: string
}

const DEFAULT_TIMEOUT_MS = 600_000 // 10 min — a headless turn can run long

/**
 * The envelope `--output-format json` prints: one object on the final line.
 *
 * Measured: `agy -p "Reply with exactly the word ok." --mode plan --output-format json`
 * returns `{ conversation_id, status: "SUCCESS", response, duration_seconds, num_turns, usage }`.
 * There is no price: the run bills against the subscription, so cost is 0.
 */
export type AgyResult = {
  readonly status: string
  readonly response: string
  readonly conversationId?: string
  readonly error?: string
  readonly usage?: {
    readonly input_tokens?: number
    readonly output_tokens?: number
    readonly thinking_tokens?: number
    readonly cache_read_tokens?: number
    readonly total_tokens?: number
  }
}

/**
 * `--print-timeout` takes a Go duration (`10m`, `45s`, `1500ms`). The CLI's own
 * default used to be five minutes; set it from the engine budget so the CLI
 * does not give up first, and so a timeout reads as a budget rather than a crash.
 */
export function formatAgyTimeout(timeoutMs: number): string {
  if (timeoutMs <= 0) return '0s'
  if (timeoutMs % 60_000 === 0) return `${timeoutMs / 60_000}m`
  if (timeoutMs % 1_000 === 0) return `${timeoutMs / 1_000}s`
  return `${timeoutMs}ms`
}

/**
 * Build the argv for one headless turn.
 *
 * Pure, so the flag decisions are testable without spawning anything — the same
 * reason `buildCursorArgs` splits its argument construction out.
 *
 * `agy` has no `--cwd`: the working directory is the spawned process's, set by
 * the caller.
 */
export function buildAgyArgs(opts: {
  readonly prompt: string
  readonly model?: string
  readonly role: AgyRole
  readonly timeoutMs: number
  readonly effort?: AgyEffort
}): string[] {
  const args = [
    // Without -p the first positional argument is still treated as a prompt, but
    // interactively: it opens the TUI and never returns. -p is not optional here.
    '-p', opts.prompt,
    '--output-format', 'json',
    '--print-timeout', formatAgyTimeout(opts.timeoutMs),
  ]
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.role === 'review') args.push('--mode', 'plan')
  else args.push('--dangerously-skip-permissions')
  return args
}

function asAgyResult(value: unknown): AgyResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.status !== 'string') return null
  const usageRaw = raw.usage
  const usageObj = usageRaw && typeof usageRaw === 'object' && !Array.isArray(usageRaw)
    ? usageRaw as Record<string, unknown>
    : undefined
  const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const usage = usageObj ? {
    ...(num(usageObj.input_tokens) !== undefined ? { input_tokens: num(usageObj.input_tokens) } : {}),
    ...(num(usageObj.output_tokens) !== undefined ? { output_tokens: num(usageObj.output_tokens) } : {}),
    ...(num(usageObj.thinking_tokens) !== undefined ? { thinking_tokens: num(usageObj.thinking_tokens) } : {}),
    ...(num(usageObj.cache_read_tokens) !== undefined ? { cache_read_tokens: num(usageObj.cache_read_tokens) } : {}),
    ...(num(usageObj.total_tokens) !== undefined ? { total_tokens: num(usageObj.total_tokens) } : {}),
  } : undefined
  const response = (typeof raw.response === 'string' && raw.response)
    || (typeof raw.error === 'string' && raw.error)
    || ''
  return {
    status: raw.status,
    response,
    ...(typeof raw.conversation_id === 'string' ? { conversationId: raw.conversation_id } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    ...(usage && Object.keys(usage).length ? { usage } : {}),
  }
}

/**
 * Read the envelope.
 *
 * The CLI prints progress before the result, so the JSON is the last object
 * that carries `status` rather than the whole of stdout.
 */
export function parseAgyResult(stdout: string): AgyResult {
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = asAgyResult(JSON.parse(line))
      if (parsed) return parsed
    } catch {
      // Not the envelope; keep walking back.
    }
  }
  throw new Error(`agy returned no JSON result: ${excerpt(stdout)}`)
}

export function createAntigravityAdapter(config: AntigravityAdapterConfig): LLMAdapter {
  return {
    async run(llmConfig: LLMConfig): Promise<LLMResponse> {
      const start = performance.now()
      const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

      const parts: string[] = []
      if (llmConfig.system) parts.push(llmConfig.system)
      for (const msg of llmConfig.messages) {
        if (typeof msg.content === 'string') parts.push(msg.content)
      }
      const prompt = parts.join('\n')

      const args = buildAgyArgs({
        prompt,
        role: config.role ?? 'review',
        timeoutMs,
        ...(config.model ? { model: config.model } : {}),
        ...(config.effort ? { effort: config.effort } : {}),
      })

      // Strip Gemini/Google API keys so the CLI uses the logged-in subscription
      // rather than metered API auth — the same reason the cursor adapter strips
      // CURSOR_API_KEY. With a key present the run may bill separately.
      const { GEMINI_API_KEY, GOOGLE_API_KEY, ...cleanEnv } = process.env

      const proc = Bun.spawn(sandboxed([config.bin ?? 'agy', ...args], config.sandbox), {
        cwd: config.cwd ?? process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: { ...cleanEnv, CI: 'true' },
      })

      const timeoutId = setTimeout(() => proc.kill(), timeoutMs)
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]).finally(() => clearTimeout(timeoutId))

      if (exitCode !== 0 && !stdout) {
        throw new Error(`agy failed (exit ${exitCode}): ${excerpt(stderr)}`)
      }

      const data = parseAgyResult(stdout)
      if (data.status !== 'SUCCESS') {
        throw new Error(`agy error: ${data.response || data.error || data.status}`)
      }

      // No tool calls are surfaced: the CLI executes its own tools inside the turn
      // and reports only the final text. A caller that needs to know whether work
      // actually happened must inspect the workspace — see commitWorktree, which
      // returns null when the tree is unchanged. A turn can end having written
      // nothing and still report success, so the text is never the evidence.
      const toolCalls: ToolCall[] = []

      return {
        content: data.response ?? '',
        toolCalls,
        stopReason: 'end_turn',
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
          cost: 0, // subscription-billed; the envelope carries no price
        },
        provider: 'antigravity',
        model: config.model ?? 'antigravity',
        durationMs: Math.round(performance.now() - start),
      }
    },
  }
}
