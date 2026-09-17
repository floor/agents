import type {
  Issue,
  ExecutionState,
  ExecutionStep,
  StateStore,
  AgentDefinition,
  ReviewVerdict,
  ProjectConfig,
  GuardrailsConfig,
} from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import { createWorktree, gitText, snapshotWorktree, removeWorktree } from './worktree.ts'
import { requireVerification, prepareWorkspace, verifyAndCommit, resolveBaseSha } from './verified-commit.ts'
import { verificationSummary } from './verification.ts'
import type { CostTracker } from './cost-tracker.ts'
import { implementerSandbox, reviewerSandbox, sandboxed, withDenyRead, type SandboxTool } from '@floor-agents/sandbox'
import { buildCursorArgs, parseCursorResult } from '@floor-agents/cursor'

/** Providers whose CLI runs as a full agent on a worktree, rather than through tool calls. */
export const NATIVE_PROVIDERS = new Set(['claude-code', 'cursor'])

export type NativeRole = 'implement' | 'review'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

async function advanceState(
  state: ExecutionState,
  step: ExecutionStep,
  updates: Partial<ExecutionState>,
  store: StateStore,
): Promise<ExecutionState> {
  const next: ExecutionState = { ...state, step, ...updates, updatedAt: new Date().toISOString() }
  await store.save(next)
  return next
}

type NativeRunResult = {
  readonly resultText: string
  readonly cost: number
  readonly durationMs: number
  readonly exitCode: number
}

/**
 * The CLI argv for one native turn. Pure, so each provider's flags are testable.
 *
 * A reviewer gets no edit tools; an implementer gets them. Neither list is
 * containment — `Bash` alone can write anywhere, and Cursor's edit tool writes
 * outside its folder even under `--trust`. The sandbox in spawnNativeAgent is.
 */
export function nativeAgentArgv(opts: {
  readonly provider: string
  readonly role: NativeRole
  readonly prompt: string
  readonly model?: string
  readonly maxTurns?: number
}): string[] {
  if (opts.provider === 'cursor') {
    return ['cursor-agent', ...buildCursorArgs({
      prompt: opts.prompt,
      ...(opts.model ? { model: opts.model } : {}),
      // An implementer runs the project's tests, which needs the shell.
      ...(opts.role === 'implement' ? { allowShell: true } : {}),
    })]
  }
  if (opts.provider === 'claude-code') {
    const tools = opts.role === 'implement' ? 'Read,Edit,Write,Bash,Glob,Grep' : 'Read,Glob,Grep,Bash'
    return [
      'claude', '-p', opts.prompt,
      '--output-format', 'json',
      '--max-turns', String(opts.maxTurns ?? 25),
      '--allowedTools', tools,
      ...(opts.model ? ['--model', opts.model] : []),
    ]
  }
  throw new Error(`No native runner for provider "${opts.provider}"`)
}

/** Read a native turn's output. Cursor reports no price, so its cost is 0. */
export function parseNativeResult(provider: string, stdout: string, stderr: string): { resultText: string; cost: number; isError: boolean } {
  if (provider === 'cursor') {
    try {
      const r = parseCursorResult(stdout)
      return { resultText: r.result ?? '', cost: 0, isError: r.is_error }
    } catch {
      return { resultText: stdout || stderr, cost: 0, isError: true }
    }
  }
  try {
    const data = JSON.parse(stdout)
    return { resultText: data.result ?? '', cost: data.total_cost_usd ?? 0, isError: Boolean(data.is_error) }
  } catch {
    return { resultText: stdout || stderr, cost: 0, isError: false }
  }
}

const sandboxTool = (provider: string): SandboxTool => (provider === 'cursor' ? 'cursor' : 'claude')

/** The default turn budget, when the manifest names none. */
export const DEFAULT_TURN_TIMEOUT_MS = 600_000

/**
 * How long one turn may run: the agent's own `timeoutMs`, else the default.
 * FLOOR_AGENTS_AGENT_TIMEOUT_MS overrides both, for extending a single run
 * without editing the manifest.
 */
export function turnTimeoutMs(agentTimeoutMs?: number, env: Readonly<Record<string, string | undefined>> = process.env): number {
  const override = Number(env.FLOOR_AGENTS_AGENT_TIMEOUT_MS)
  if (Number.isFinite(override) && override > 0) return override
  return agentTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
}

/**
 * Run one native turn inside the operating-system sandbox.
 *
 * An implementer may write its worktree and that worktree's git metadata; a
 * reviewer may write nothing but its CLI's state. Where the sandbox is
 * unavailable the turn is refused, not run uncontained.
 */
export async function spawnNativeAgent(opts: {
  readonly provider: string
  readonly role: NativeRole
  readonly prompt: string
  readonly cwd: string
  readonly model?: string
  readonly writable: readonly string[]
  readonly maxTurns?: number
  readonly timeoutMs?: number
  /** Paths the agent may not read: the private sources its provider is not trusted with. */
  readonly denyRead?: readonly string[]
  /** For tests: the home directory the sandbox protects. */
  readonly home?: string
}): Promise<NativeRunResult> {
  // Both keys are stripped so each CLI authenticates through its logged-in
  // subscription session instead of metered per-token API billing.
  const { ANTHROPIC_API_KEY, CURSOR_API_KEY, ...cleanEnv } = process.env
  const tool = sandboxTool(opts.provider)
  const spec = withDenyRead(opts.role === 'implement'
    ? implementerSandbox(tool, opts.writable, process.env, opts.home)
    : reviewerSandbox(tool, process.env, opts.home), opts.denyRead ?? [])
  const args = sandboxed(nativeAgentArgv(opts), spec)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS

  const start = performance.now()

  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    detached: process.platform !== 'win32',
    env: { ...cleanEnv, CLAUDE_CODE_SKIP_HOOKS: '1', ...(opts.provider === 'cursor' ? { CI: 'true' } : {}) },
  })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    try {
      if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL')
      else proc.kill('SIGKILL')
    } catch { proc.kill('SIGKILL') }
  }, timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  clearTimeout(timeout)

  const durationMs = Math.round(performance.now() - start)
  const { resultText, cost, isError } = parseNativeResult(opts.provider, stdout, stderr)

  // A clean exit that reports an error is still a failure.
  return { resultText, cost, durationMs, exitCode: timedOut ? 143 : exitCode === 0 && isError ? 1 : exitCode }
}

// ── Dev agent: native execution on worktree ─────────────────────

export type NativeAgentDeps = {
  readonly runAgent?: (prompt: string, cwd: string, model?: string) => Promise<NativeRunResult>
  readonly contextBuilder: ContextBuilder
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly addComment: (issueId: string, text: string) => Promise<void>
  readonly setLabel: (issueId: string, label: string) => Promise<void>
  readonly project: ProjectConfig
  readonly guardrails: GuardrailsConfig
  /** Private sources this agent's provider is not trusted with. */
  readonly denyRead?: readonly string[]
}

export async function runNativeDevAgent(
  issue: Issue,
  agent: AgentDefinition,
  state: ExecutionState,
  deps: NativeAgentDeps,
  reviewComments?: string,
): Promise<ExecutionState> {
  const { contextBuilder, stateStore, costTracker, addComment } = deps

  requireVerification(deps.project)

  state = await advanceState(state, 'calling_llm', {}, stateStore)

  const worktree = await createWorktree(state.branchName!, deps.project.root)
  state = await advanceState(state, 'calling_llm', {
    workspacePath: worktree.path, baseSha: await resolveBaseSha(worktree, deps.project, state), verification: undefined,
  }, stateStore)
  const isRevision = !!reviewComments

  console.log(`[${agent.id}] native agent on worktree: ${worktree.path}`)

  await addComment(issue.id, [
    isRevision
      ? `⏳ **${agent.name}** is addressing review feedback...`
      : `⏳ **${agent.name}** is working on the code...`,
    `> Model: \`${agent.llm.model}\` via ${agent.llm.provider} (native mode)`,
    `> Worktree: \`${state.branchName}\``,
  ].join('\n'))

  try {
    await prepareWorkspace(worktree, deps.project)
    // Build context hints
    const ctx = await contextBuilder.build({
      agent,
      issue,
      project: deps.project,
      reviewComments,
      ref: worktree.initialSha,
    })

    const promptParts = [
      ctx.systemPrompt,
      '',
      '## Task',
      `**${issue.title}**`,
      issue.body || '',
    ]

    if (reviewComments) {
      promptParts.push('', '## Review Feedback (address these)', reviewComments)
    }

    promptParts.push(
      '',
      '## Instructions',
      'You are working directly on a git branch. Edit files, run tests, iterate until the code is correct.',
      `Project checks: ${deps.project.verification!.map(c => c.command.join(' ')).join('; ')}. The engine will run these independently.`,
      'Do not commit, push, or open a PR. The engine validates and publishes the final changes.',
      'Do NOT use write_file or pr_description tools — edit files directly.',
    )

    // The implementer may write its worktree and that worktree's own git metadata
    // (index, locks) — nothing else, including the main checkout it came from.
    const gitDir = await gitText(worktree.path, ['rev-parse', '--absolute-git-dir'])
    const runAgent = deps.runAgent ?? ((prompt: string, cwd: string, model?: string) => spawnNativeAgent({
      provider: agent.llm.provider, role: 'implement', prompt, cwd, writable: [cwd, gitDir], denyRead: deps.denyRead ?? [],
      timeoutMs: turnTimeoutMs(agent.timeoutMs), ...(model ? { model } : {}),
    }))
    const result = await runAgent(
      promptParts.join('\n'),
      worktree.path,
      agent.llm.model,
    )

    costTracker.recordCost(issue.id, result.cost)
    state = await advanceState(state, 'calling_llm', { costUsd: costTracker.getTaskCost(issue.id), llmResponse: result.resultText }, stateStore)
    console.log(`[${agent.id}] native agent: ${formatDuration(result.durationMs)}, $${result.cost.toFixed(4)}, exit ${result.exitCode}`)

    if (result.exitCode !== 0) {
      // 143 is the runner's own deadline: say so, since the agent's output is
      // empty and "failed (exit 143)" reads like a crash.
      const why = result.exitCode === 143
        ? `did not finish within ${Math.round(turnTimeoutMs(agent.timeoutMs) / 60_000)} minutes (raise the agent's timeoutMs in the manifest)`
        : `failed (exit ${result.exitCode})`
      throw new Error(`${agent.llm.provider} agent ${why}: ${result.resultText.slice(0, 500)}`)
    }

    state = await verifyAndCommit(
      worktree, deps.project, deps.guardrails, state, stateStore,
      `${issue.title}\n\nAutomated by Floor Agents (${agent.name})\nTask: ${issue.id}\nReview cycle: ${state.reviewCycle}`,
    )

    const diffText = await gitText(worktree.path, ['diff', state.baseSha!, state.commitSha!, '--stat'])

    await addComment(issue.id, [
      `✅ **${agent.name}** completed work (native mode):`,
      '```',
      diffText,
      '```',
      `> ${formatDuration(result.durationMs)} | $${result.cost.toFixed(4)}`,
      verificationSummary(state.verification!),
    ].join('\n'))

    state = await advanceState(state, 'creating_pr', {
      costUsd: costTracker.getTaskCost(issue.id),
      llmResponse: result.resultText,
    }, stateStore)
    await removeWorktree(worktree)
    return state
  } catch (err) {
    console.error(`[${agent.id}] workspace preserved: ${worktree.path}`)
    throw err
  }
}

// ── CTO review: native execution on worktree ────────────────────

export type NativeReviewDeps = {
  readonly stateStore: StateStore
  readonly costTracker: CostTracker
  readonly addComment: (issueId: string, text: string) => Promise<void>
  readonly addPRComment: (prId: string, body: string) => Promise<void>
  readonly getPRDiff: (prId: string) => Promise<string>
  readonly project: ProjectConfig
  readonly maxReviewCycles: number
  /** Private sources this reviewer's provider is not trusted with. */
  readonly denyRead?: readonly string[]
}

export async function runNativeReviewAgent(
  issue: Issue,
  reviewer: AgentDefinition,
  state: ExecutionState,
  deps: NativeReviewDeps,
): Promise<ExecutionState> {
  const { stateStore, costTracker, addComment, addPRComment } = deps

  state = await advanceState(state, 'reviewing', {}, stateStore)

  const worktree = await createWorktree(state.branchName!, deps.project.root)

  console.log(`[${reviewer.id}] native review on worktree: ${worktree.path}`)

  await addComment(issue.id, [
    `🔎 **${reviewer.name}** is reviewing the PR (native mode)...`,
    `> Model: \`${reviewer.llm.model}\` via ${reviewer.llm.provider}`,
    `> Review cycle: ${state.reviewCycle + 1}/${deps.maxReviewCycles}`,
    `> Engine checks: ${state.verification?.passed ? 'passed' : 'not recorded'}`,
  ].join('\n'))

  try {
    if (state.commitSha && worktree.initialSha !== state.commitSha) throw new Error('PR branch changed since implementation; refusing a stale review')
    await prepareWorkspace(worktree, deps.project)
    const reviewTree = await snapshotWorktree(worktree)
    let rolePrompt = ''
    try {
      const file = Bun.file(reviewer.promptTemplate)
      if (await file.exists()) rolePrompt = await file.text()
    } catch {}
    if (!rolePrompt) rolePrompt = 'You are a code reviewer.'

    const diff = await deps.getPRDiff(state.prId!)

    const prompt = [
      rolePrompt,
      '',
      '## Project',
      `Project: ${deps.project.name}`,
      '',
      '## Task Being Reviewed',
      `**${issue.title}**`,
      issue.body || '',
      '',
      '## PR Diff',
      '```diff',
      diff,
      '```',
      '',
      '## Instructions',
      'You are on the branch with the agent\'s changes. Please:',
      '1. Inspect the implementation and related tests; do not edit, commit, or push.',
      state.verification ? verificationSummary(state.verification) : 'No engine verification recorded. Do not claim tests passed.',
      '2. Review the code for correctness, security, style, and documentation',
      '3. At the end, output your verdict as a JSON block:',
      '```json',
      '{ "decision": "approve" or "request_changes", "comments": "your review" }',
      '```',
      'Only approve if the code is correct. Test claims must match the engine results above.',
    ].join('\n')

    // A reviewer writes nothing: the sandbox denies every write outside its CLI's
    // state, and the snapshot check below still fails closed on any change.
    const result = await spawnNativeAgent({
      provider: reviewer.llm.provider, role: 'review', prompt, cwd: worktree.path, writable: [], denyRead: deps.denyRead ?? [],
      timeoutMs: turnTimeoutMs(reviewer.timeoutMs), model: reviewer.llm.model,
    })

    costTracker.recordCost(issue.id, result.cost)
    console.log(`[${reviewer.id}] native review: ${formatDuration(result.durationMs)}, $${result.cost.toFixed(4)}, exit ${result.exitCode}`)

    // Extract verdict from the response. Fail closed: default to request_changes
    // so a missing/unparseable verdict never counts as an approval.
    let verdict: ReviewVerdict = {
      decision: 'request_changes',
      comments: 'No review verdict could be parsed from the reviewer output — failing closed.',
    }

    const jsonMatch = result.resultText.match(/```json\s*([\s\S]*?)```/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]!)
        if (parsed.decision === 'approve' || parsed.decision === 'request_changes') {
          verdict = { decision: parsed.decision, comments: parsed.comments ?? '' }
        }
      } catch {}
    }

    // Also try to parse the whole response if no json block found
    if (!jsonMatch) {
      try {
        const parsed = JSON.parse(result.resultText)
        if (parsed.decision === 'approve' || parsed.decision === 'request_changes') {
          verdict = { decision: parsed.decision, comments: parsed.comments ?? '' }
        }
      } catch {}
    }

    // A crashed or timed-out reviewer must never count as an approval.
    // exit 143 represents the runner deadline; any nonzero exit is a failure.
    if (result.exitCode !== 0 || reviewTree !== await snapshotWorktree(worktree)) {
      verdict = {
        decision: 'request_changes',
        comments: result.exitCode === 143
          ? 'Reviewer timed out before producing a verdict — failing closed.'
          : 'Reviewer failed or modified the workspace — failing closed.',
      }
    }

    console.log(`[${reviewer.id}] verdict: ${verdict.decision}`)

    // Post review as PR comment
    await addPRComment(
      state.prId!,
      [
        `## ${reviewer.name} Review (cycle ${state.reviewCycle + 1})`,
        '',
        `**Verdict:** ${verdict.decision === 'approve' ? '✅ Approved' : '🔄 Changes Requested'}`,
        '',
        verdict.comments,
        '',
        `*Model: ${reviewer.llm.model} | ${formatDuration(result.durationMs)} | $${result.cost.toFixed(4)}*`,
      ].join('\n'),
    )

    if (verdict.decision === 'approve') {
      await addComment(issue.id, [
        `✅ **${reviewer.name}** approved the PR`,
        '',
        `> ${verdict.comments.length > 200 ? verdict.comments.slice(0, 200) + '...' : verdict.comments}`,
      ].join('\n'))
    } else {
      await addComment(issue.id, [
        `🔄 **${reviewer.name}** requested changes (cycle ${state.reviewCycle + 1}/${deps.maxReviewCycles})`,
        '',
        `> ${verdict.comments.length > 300 ? verdict.comments.slice(0, 300) + '...' : verdict.comments}`,
      ].join('\n'))
    }

    return advanceState(state, verdict.decision === 'approve' ? 'updating_issue' : 'revision', {
      reviewVerdict: verdict,
      reviewCycle: state.reviewCycle + 1,
      costUsd: costTracker.getTaskCost(issue.id),
    }, stateStore)
  } finally {
    await removeWorktree(worktree)
  }
}
