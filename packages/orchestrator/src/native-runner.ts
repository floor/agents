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
import { DEFAULT_FIX_TURNS } from '@floor-agents/core'
import type { ContextBuilder } from '@floor-agents/context-builder'
import { createWorktree, gitText, snapshotWorktree, removeWorktree, reopenWorktree } from './worktree.ts'
import { requireVerification, prepareWorkspace, verifyAndCommit, resolveBaseSha } from './verified-commit.ts'
import { verificationSummary, isRepairableGateFailure, isRepairableVerification, latestFailingCheck, gateFailureSection, VerificationFailed } from './verification.ts'
import type { CostTracker } from './cost-tracker.ts'
import { implementerSandbox, reviewerSandbox, sandboxed, withDenyRead, type SandboxTool } from '@floor-agents/sandbox'
import { buildCursorArgs, parseCursorResult } from '@floor-agents/cursor'
import { buildAgyArgs, parseAgyResult } from '@floor-agents/antigravity'
import { costNote, metaLine } from './cost-note.ts'
import { AgentStopped, GateExhausted, writtenSummary } from './stop-report.ts'

/** Providers whose CLI runs as a full agent on a worktree, rather than through tool calls. */
export const NATIVE_PROVIDERS = new Set(['claude-code', 'cursor', 'antigravity'])

export type NativeRole = 'implement' | 'review'

/**
 * How many tool calls a turn may make when the manifest says nothing. Claude
 * Code counts every tool call as a turn; measured on floor/vlist#220, an
 * implementer touching four files ran out at the old cap of 25 after four
 * minutes, with the work half done and no result. The time budget already
 * bounds a runaway turn, so the cap only needs to be larger than honest work.
 */
export const DEFAULT_MAX_TURNS: Readonly<Record<NativeRole, number>> = { implement: 300, review: 60 }

/** The default turn budget, when the manifest names none. */
export const DEFAULT_TURN_TIMEOUT_MS = 600_000

/**
 * What a native implementer is told — first pass and revision share this.
 *
 * Never name the API-path tools: Antigravity's file tool is itself called
 * `write_file`, and Gemini treated a prohibition on that name as "print the
 * files, write nothing" (mtrl FLO-102).
 */
export function nativeImplementerInstructions(): readonly string[] {
  return [
    '## Instructions',
    'You are working directly on a git branch. Edit files; run the type check and the tests of the files you touched.',
    'The engine runs the full gate and hands you any failure.',
    'Do not commit, push, or open a PR. The engine validates and publishes the final changes.',
    'Edit the files in this working directory with your own editing tools; do not print file contents in your reply — a reply is not a change. The engine reads the working tree, not your message.',
  ]
}

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
  readonly subtype?: string
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
  readonly timeoutMs?: number
}): string[] {
  if (opts.provider === 'cursor') {
    return ['cursor-agent', ...buildCursorArgs({
      prompt: opts.prompt,
      ...(opts.model ? { model: opts.model } : {}),
      // An implementer runs the project's tests, which needs the shell.
      ...(opts.role === 'implement' ? { allowShell: true } : {}),
    })]
  }
  if (opts.provider === 'antigravity') {
    return ['agy', ...buildAgyArgs({
      prompt: opts.prompt,
      role: opts.role,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      ...(opts.model ? { model: opts.model } : {}),
    })]
  }
  if (opts.provider === 'claude-code') {
    const tools = opts.role === 'implement' ? 'Read,Edit,Write,Bash,Glob,Grep' : 'Read,Glob,Grep,Bash'
    return [
      'claude', '-p', opts.prompt,
      '--output-format', 'json',
      '--max-turns', String(opts.maxTurns ?? DEFAULT_MAX_TURNS[opts.role]),
      '--allowedTools', tools,
      ...(opts.model ? ['--model', opts.model] : []),
    ]
  }
  throw new Error(`No native runner for provider "${opts.provider}"`)
}

export type NativeParsed = {
  readonly resultText: string
  readonly cost: number
  readonly isError: boolean
  /** The envelope's own reason, when it gives one: `error_max_turns`, `success`. */
  readonly subtype?: string
}

function agyTimeout(status: string, text: string): boolean {
  return status === 'TIMEOUT' || /print[- ]?timeout|timed? out|deadline/i.test(`${status} ${text}`)
}

/** Read a native turn's output. Cursor and agy report no price, so their cost is 0. */
export function parseNativeResult(provider: string, stdout: string, stderr: string): NativeParsed {
  if (provider === 'cursor') {
    try {
      const r = parseCursorResult(stdout)
      return { resultText: r.result ?? '', cost: 0, isError: r.is_error, ...(r.subtype ? { subtype: r.subtype } : {}) }
    } catch {
      return { resultText: stdout || stderr, cost: 0, isError: true }
    }
  }
  if (provider === 'antigravity') {
    try {
      const r = parseAgyResult(stdout)
      const resultText = r.response || r.error || ''
      const timedOut = r.status !== 'SUCCESS' && agyTimeout(r.status, resultText)
      return {
        resultText,
        cost: 0,
        isError: r.status !== 'SUCCESS',
        ...(timedOut ? { subtype: 'TIMEOUT' } : r.status ? { subtype: r.status } : {}),
      }
    } catch {
      return { resultText: stdout || stderr, cost: 0, isError: true }
    }
  }
  try {
    const data = JSON.parse(stdout)
    return {
      resultText: data.result ?? '', cost: data.total_cost_usd ?? 0, isError: Boolean(data.is_error),
      ...(typeof data.subtype === 'string' ? { subtype: data.subtype } : {}),
    }
  } catch {
    return { resultText: stdout || stderr, cost: 0, isError: false }
  }
}

/** Why a turn failed, in the words a person can act on. */
export function failureReason(exitCode: number, subtype: string | undefined, budget: { timeoutMs: number; maxTurns: number }): string {
  if (exitCode === 143 || subtype === 'TIMEOUT') {
    return `did not finish within ${Math.round(budget.timeoutMs / 60_000)} minutes (raise the agent's timeoutMs in the manifest)`
  }
  if (subtype === 'error_max_turns') {
    return `stopped at its cap of ${budget.maxTurns} tool calls with no result (raise the agent's maxTurns in the manifest)`
  }
  return `failed (exit ${exitCode}${subtype ? `, ${subtype}` : ''})`
}

function sandboxTool(provider: string): SandboxTool {
  if (provider === 'cursor') return 'cursor'
  if (provider === 'antigravity') return 'antigravity'
  return 'claude'
}

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
  // API keys are stripped so each CLI authenticates through its logged-in
  // subscription session instead of metered per-token API billing.
  const { ANTHROPIC_API_KEY, CURSOR_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, ...cleanEnv } = process.env
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
    env: { ...cleanEnv, CLAUDE_CODE_SKIP_HOOKS: '1', ...(opts.provider === 'cursor' || opts.provider === 'antigravity' ? { CI: 'true' } : {}) },
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
  const { resultText, cost, isError, subtype } = parseNativeResult(opts.provider, stdout, stderr)

  // A clean exit that reports an error is still a failure.
  return {
    resultText, cost, durationMs, exitCode: timedOut ? 143 : exitCode === 0 && isError ? 1 : exitCode,
    ...(subtype ? { subtype } : {}),
  }
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
  /** Issue comments already rendered as a `## Discussion` block, or omitted. */
  readonly discussion?: string
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

  const incoming = state
  state = await advanceState(state, 'calling_llm', {}, stateStore)

  const existing = incoming.step === 'calling_llm' && incoming.workspacePath && incoming.initialSha
    ? await reopenWorktree(incoming.workspacePath, incoming.branchName!, incoming.initialSha)
    : null
  const resumed = Boolean(existing)
  const worktree = existing ?? await createWorktree(state.branchName!, deps.project.root)

  state = await advanceState(state, 'calling_llm', {
    workspacePath: worktree.path,
    baseSha: await resolveBaseSha(worktree, deps.project, state),
    initialSha: worktree.initialSha,
    ...(resumed ? {} : { verification: undefined }),
  }, stateStore)
  const isRevision = !!reviewComments
  // Only a persisted repairable gate failure skips the implementer. A leftover
  // llmResponse from a previous turn (or a revision that crashed mid-agent)
  // must not count as "the agent already ran".
  const skipInitial = resumed && isRepairableVerification(state.verification)

  console.log(`[${agent.id}] native agent on worktree: ${worktree.path}${resumed ? ' (resumed)' : ''}`)

  if (!skipInitial) {
    await addComment(issue.id, [
      isRevision
        ? `⏳ **${agent.name}** is addressing review feedback...`
        : `⏳ **${agent.name}** is working on the code...`,
      `> Model: \`${agent.llm.model}\` via ${agent.llm.provider} (native mode)`,
      `> Worktree: \`${state.branchName}\``,
    ].join('\n'))
  }

  try {
    await prepareWorkspace(worktree, deps.project)
    // Native: omit API-path tool names from the role template and Output
    // section. agy's file tool is itself called write_file (mtrl FLO-102).
    const ctx = await contextBuilder.build({
      agent,
      issue,
      project: deps.project,
      reviewComments,
      ref: worktree.initialSha,
      native: true,
    })

    const promptBase = [
      ctx.systemPrompt,
      '',
      '## Task',
      `**${issue.title}**`,
      issue.body || '',
    ]
    if (deps.discussion) promptBase.push('', deps.discussion)
    if (reviewComments) promptBase.push('', '## Review Feedback (address these)', reviewComments)
    promptBase.push('', ...nativeImplementerInstructions())

    const gitDir = await gitText(worktree.path, ['rev-parse', '--absolute-git-dir'])
    const budget = { timeoutMs: turnTimeoutMs(agent.timeoutMs), maxTurns: agent.maxTurns ?? DEFAULT_MAX_TURNS.implement }
    const runAgent = deps.runAgent ?? ((prompt: string, cwd: string, model?: string) => spawnNativeAgent({
      provider: agent.llm.provider, role: 'implement', prompt, cwd, writable: [cwd, gitDir], denyRead: deps.denyRead ?? [],
      timeoutMs: budget.timeoutMs, maxTurns: budget.maxTurns, ...(model ? { model } : {}),
    }))

    const uncommittedSummary = async (): Promise<string> => writtenSummary(
      await gitText(worktree.path, ['diff', '--stat', 'HEAD']),
      await gitText(worktree.path, ['ls-files', '--others', '--exclude-standard']),
    )

    const cumulativeDiff = async (): Promise<string> => {
      const tree = await snapshotWorktree(worktree)
      return gitText(worktree.path, ['diff', '--stat', state.baseSha ?? worktree.initialSha, tree])
    }

    const runTurn = async (prompt: string): Promise<NativeRunResult> => {
      const result = await runAgent(prompt, worktree.path, agent.llm.model)
      costTracker.recordCost(issue.id, result.cost)
      state = await advanceState(state, 'calling_llm', { costUsd: costTracker.getTaskCost(issue.id), llmResponse: result.resultText }, stateStore)
      console.log(`[${agent.id}] native agent: ${formatDuration(result.durationMs)}, $${result.cost.toFixed(4)}, exit ${result.exitCode}`)
      if (result.exitCode !== 0) {
        throw new AgentStopped(
          `${agent.llm.provider} agent ${failureReason(result.exitCode, result.subtype, budget)}: ${result.resultText.slice(0, 500)}`.trimEnd().replace(/:$/, ''),
          await uncommittedSummary(),
        )
      }
      return result
    }

    let result: NativeRunResult = { resultText: state.llmResponse ?? '', cost: 0, durationMs: 0, exitCode: 0 }
    let sessionDuration = 0
    let sessionCost = 0
    const allowance = deps.project.fixTurns ?? DEFAULT_FIX_TURNS
    const commitMessage = `${issue.title}\n\nAutomated by Floor Agents (${agent.name})\nTask: ${issue.id}\nReview cycle: ${state.reviewCycle}`

    if (!skipInitial) {
      result = await runTurn(promptBase.join('\n'))
      sessionDuration = result.durationMs
      sessionCost = result.cost
    }

    for (;;) {
      try {
        state = await verifyAndCommit(worktree, deps.project, deps.guardrails, state, stateStore, commitMessage)
        break
      } catch (err) {
        if (err instanceof VerificationFailed) state = err.saved
        if (!isRepairableGateFailure(err) || allowance <= 0) throw err
        const used = state.fixTurnsUsed ?? 0
        const failing = latestFailingCheck(err.verification)
        const written = await uncommittedSummary()
        if (!failing || used >= allowance) {
          throw new GateExhausted(
            err.message,
            failing ?? { name: 'gate', command: [], exitCode: 1, timedOut: false, durationMs: 0, stdout: '', stderr: '' },
            used + 1,
            written,
          )
        }
        state = await advanceState(state, 'calling_llm', { fixTurnsUsed: used + 1 }, stateStore)
        console.log(`[${agent.id}] gate failure: ${failing.name} (exit ${failing.exitCode}) — fix turn ${used + 1}/${allowance}`)
        await addComment(issue.id, `🔧 **${agent.name}** is fixing a gate failure (\`${failing.name}\`, exit ${failing.exitCode}) — fix turn ${used + 1} of ${allowance}`)
        result = await runTurn([...promptBase, '', ...gateFailureSection(failing, await cumulativeDiff())].join('\n'))
        sessionDuration += result.durationMs
        sessionCost += result.cost
      }
    }

    const diffText = await gitText(worktree.path, ['diff', state.baseSha!, state.commitSha!, '--stat'])
    const gateMs = (state.gateRuns ?? []).reduce((sum, g) => sum + g.durationMs, 0)

    await addComment(issue.id, [
      `✅ **${agent.name}** completed work (native mode):`,
      '```',
      diffText,
      '```',
      `> ${metaLine([formatDuration(sessionDuration + gateMs), costNote(sessionCost)])}`,
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
      timeoutMs: turnTimeoutMs(reviewer.timeoutMs), maxTurns: reviewer.maxTurns ?? DEFAULT_MAX_TURNS.review, model: reviewer.llm.model,
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
        `*${metaLine([`Model: ${reviewer.llm.model}`, formatDuration(result.durationMs), costNote(result.cost)])}*`,
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
