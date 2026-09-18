/**
 * The history of a run: every implementer turn, every gate run on its tree,
 * every review cycle — appended to the execution state, never overwritten.
 *
 * All of these are pure: they take a state and return the next one. Saving is
 * the caller's business, so the history is written by the same `store.save`
 * that already advances the cursor.
 */

import type {
  Attempt, AttemptOutcome, ExecutionState, GateRun, ReviewRecord, VerificationResult,
} from '@floor-agents/core'

/** Lines of a failing check's output kept in the history; the full output stays in `state.verification`. */
const TAIL_LINES = 80
const REPLY_CHARS = 600

const now = (): string => new Date().toISOString()

export function lastAttempt(state: ExecutionState): Attempt | undefined {
  return state.attempts?.at(-1)
}

/** Start a new attempt. Its number continues across retries: attempt 4 of an issue is its fourth turn, ever. */
export function openAttempt(
  state: ExecutionState,
  fields: Pick<Attempt, 'kind' | 'agentId' | 'model' | 'baseSha'> & { readonly worktreePath: string },
): ExecutionState {
  const attempts = state.attempts ?? []
  const attempt: Attempt = { n: attempts.length + 1, startedAt: now(), gates: [], outcome: 'running', ...fields }
  return { ...state, attempts: [...attempts, attempt] }
}

/** Change the attempt in progress. A state with no attempt is returned as it is. */
export function patchAttempt(state: ExecutionState, patch: Partial<Omit<Attempt, 'n' | 'gates'>>): ExecutionState {
  const attempts = state.attempts ?? []
  const current = attempts.at(-1)
  if (!current) return state
  return { ...state, attempts: [...attempts.slice(0, -1), { ...current, ...patch }] }
}

/** What the CLI turn itself produced, before any gate. */
export function recordTurn(
  state: ExecutionState,
  turn: { readonly durationMs: number; readonly exitCode: number; readonly subtype?: string; readonly reply: string },
): ExecutionState {
  return patchAttempt(state, {
    turnMs: turn.durationMs,
    exitCode: turn.exitCode,
    ...(turn.subtype ? { subtype: turn.subtype } : {}),
    reply: turn.reply.trim().slice(0, REPLY_CHARS),
  })
}

function tail(text: string): string {
  const lines = text.split('\n').filter(line => line.trim())
  return lines.slice(-TAIL_LINES).join('\n')
}

/** A gate run as the history keeps it: every check's verdict and time, and the end of what a failing one printed. */
export function gateRunOf(verification: VerificationResult): GateRun {
  return {
    at: verification.checkedAt,
    treeSha: verification.treeSha,
    passed: verification.passed,
    durationMs: verification.checks.reduce((sum, check) => sum + check.durationMs, 0),
    checks: verification.checks.map(check => {
      const failed = check.exitCode !== 0 || check.timedOut
      const output = failed ? tail([check.stdout, check.stderr].filter(Boolean).join('\n')) : ''
      return {
        name: check.name, exitCode: check.exitCode, timedOut: check.timedOut, durationMs: check.durationMs,
        ...(output ? { tail: output } : {}),
      }
    }),
    ...(verification.error ? { error: verification.error } : {}),
  }
}

export function recordGate(state: ExecutionState, verification: VerificationResult): ExecutionState {
  const attempts = state.attempts ?? []
  const current = attempts.at(-1)
  if (!current) return state
  return { ...state, attempts: [...attempts.slice(0, -1), { ...current, gates: [...current.gates, gateRunOf(verification)] }] }
}

/**
 * End the attempt in progress. A published attempt gives up its worktree (it is
 * removed); any other outcome keeps the path, because that directory is the work.
 */
export function closeAttempt(
  state: ExecutionState,
  outcome: Exclude<AttemptOutcome, 'running'>,
  extra: { readonly commitSha?: string; readonly error?: string } = {},
): ExecutionState {
  const current = lastAttempt(state)
  if (!current || current.outcome !== 'running') return state
  const { worktreePath, ...rest } = current
  const closed: Attempt = {
    ...(outcome === 'published' ? rest : current),
    outcome, endedAt: now(),
    ...(extra.commitSha ? { commitSha: extra.commitSha } : {}),
    ...(extra.error ? { error: extra.error.slice(0, 1_000) } : {}),
  }
  return { ...state, attempts: [...(state.attempts ?? []).slice(0, -1), closed] }
}

/** Which outcome an exception from the turn-and-publish path stands for. */
export function outcomeOf(err: unknown): Exclude<AttemptOutcome, 'running' | 'published'> {
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)
  if (name === 'AgentStopped') return 'stopped'
  if (/^Agent made no changes/.test(message)) return 'no-changes'
  if (/^Guardrail|^Unsupported file mode/.test(message)) return 'guardrail'
  if (/^Verification failed|^Checks modified the workspace/.test(message)) return 'gate-failed'
  return 'error'
}

export function recordReview(state: ExecutionState, review: ReviewRecord): ExecutionState {
  return { ...state, reviews: [...(state.reviews ?? []), review] }
}

/** What a retry keeps from the run it replaces. */
export function historyOf(state: ExecutionState | null | undefined): Pick<ExecutionState, 'attempts' | 'reviews'> {
  return {
    ...(state?.attempts?.length ? { attempts: state.attempts } : {}),
    ...(state?.reviews?.length ? { reviews: state.reviews } : {}),
  }
}

const minutes = (ms: number | undefined): string =>
  ms === undefined ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`

/** The history as a person reads it — `floor-agents status --issue`. */
export function historyText(state: ExecutionState, exists: (path: string) => boolean = () => true): string {
  const lines: string[] = [
    `step: ${state.step}${state.error ? ` — ${state.error.split('\n')[0]}` : ''}`,
    ...(state.branchName ? [`branch: ${state.branchName}`] : []),
    ...(state.prUrl ? [`PR: ${state.prUrl}`] : []),
  ]
  const attempts = state.attempts ?? []
  lines.push('', attempts.length ? 'attempts:' : 'attempts: none recorded')
  for (const a of attempts) {
    const gate = a.gates.at(-1)
    const failing = gate?.checks.find(c => c.exitCode !== 0 || c.timedOut)
    const gateText = !gate ? 'no gate' : gate.passed ? `gate passed (${minutes(gate.durationMs)})` : `gate failed at ${failing?.name ?? 'the workspace check'}`
    const tree = a.worktreePath ? (exists(a.worktreePath) ? `tree kept at ${a.worktreePath}` : 'tree gone') : ''
    lines.push(`  ${a.n}. ${a.kind} · ${a.agentId} (${a.model}) · turn ${minutes(a.turnMs)} · ${a.outcome} · ${gateText}${a.commitSha ? ` · ${a.commitSha.slice(0, 8)}` : ''}${tree ? ` · ${tree}` : ''}`)
    if (a.outcome !== 'published' && a.error) lines.push(`     ${a.error.split('\n')[0]}`)
    if (failing?.tail) lines.push(...failing.tail.split('\n').slice(-6).map(l => `     | ${l}`))
  }
  const reviews = state.reviews ?? []
  if (reviews.length) lines.push('', 'reviews:')
  for (const r of reviews) {
    lines.push(`  cycle ${r.cycle} · ${minutes(r.durationMs)} · ${r.outcome} · ${r.votes.map(v => `${v.agentName} ${v.vote}${v.execution === 'failed' ? ' (failed)' : ''}`).join(', ')}`)
  }
  return lines.join('\n')
}
