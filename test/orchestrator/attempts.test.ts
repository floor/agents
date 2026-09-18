import { describe, expect, test } from 'bun:test'
import type { ExecutionState, VerificationResult } from '@floor-agents/core'
import {
  closeAttempt, gateRunOf, historyOf, historyText, lastAttempt, openAttempt, outcomeOf, recordGate, recordReview, recordTurn,
} from '../../packages/orchestrator/src/attempts.ts'
import { freshState } from '../../packages/orchestrator/src/pipeline.ts'
import { AgentStopped } from '../../packages/orchestrator/src/stop-report.ts'

const open = (state: ExecutionState, kind: 'implement' | 'revision' = 'implement'): ExecutionState =>
  openAttempt(state, { kind, agentId: 'grok-dev', model: 'cursor-grok-4.6-high', baseSha: 'base', worktreePath: '/w/attempt' })

const gate = (failing?: { name: string; output: string }): VerificationResult => ({
  passed: !failing, treeSha: 'tree', checkedAt: '2026-09-18T12:00:00.000Z',
  checks: [
    { name: 'Typecheck', command: ['bun', 'run', 'typecheck'], exitCode: 0, timedOut: false, durationMs: 5_000, stdout: 'ok', stderr: '' },
    ...(failing ? [{ name: failing.name, command: ['bun', 'run', 'size'], exitCode: 1, timedOut: false, durationMs: 100, stdout: failing.output, stderr: '' }] : []),
  ],
})

describe('the attempt record', () => {
  test('attempts are numbered across the life of the issue, and only the last one is patched', () => {
    let state = open(freshState('42', 'grok-dev'))
    state = closeAttempt(state, 'gate-failed', { error: 'Verification failed: Bundle size (exit 1)' })
    state = open(state, 'implement')
    expect(state.attempts!.map(a => a.n)).toEqual([1, 2])
    state = recordTurn(state, { durationMs: 747_000, exitCode: 0, reply: '  done  ' })
    expect(state.attempts![0]!.turnMs).toBeUndefined()
    expect(lastAttempt(state)).toMatchObject({ n: 2, turnMs: 747_000, exitCode: 0, reply: 'done', outcome: 'running' })
  })

  test('a gate run keeps every verdict and the end of what the failing check printed', () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n  ✗ carousel: 15262 bytes gzipped (budget 15257)'
    const run = gateRunOf(gate({ name: 'Bundle size', output }))
    expect(run.passed).toBe(false)
    expect(run.durationMs).toBe(5_100)
    expect(run.checks[0]).toEqual({ name: 'Typecheck', exitCode: 0, timedOut: false, durationMs: 5_000 })
    expect(run.checks[1]!.tail).toContain('carousel: 15262 bytes gzipped (budget 15257)')
    expect(run.checks[1]!.tail!.split('\n').length).toBe(80)
    expect(run.checks[1]!.tail).not.toContain('line 0\n')
  })

  test('gate runs accumulate on the attempt: a failed one, then the one that passed', () => {
    let state = open(freshState('42', 'grok-dev'))
    state = recordGate(state, gate({ name: 'Bundle size', output: 'over by 5 bytes' }))
    state = recordGate(state, gate())
    expect(lastAttempt(state)!.gates.map(g => g.passed)).toEqual([false, true])
  })

  test('a published attempt gives up its worktree; any other outcome keeps the path, because that directory is the work', () => {
    const published = closeAttempt(open(freshState('42', 'grok-dev')), 'published', { commitSha: 'abc123' })
    expect(lastAttempt(published)).toMatchObject({ outcome: 'published', commitSha: 'abc123' })
    expect(lastAttempt(published)!.worktreePath).toBeUndefined()
    const failed = closeAttempt(open(freshState('42', 'grok-dev')), 'gate-failed', { error: 'x' })
    expect(lastAttempt(failed)!.worktreePath).toBe('/w/attempt')
    expect(lastAttempt(failed)!.endedAt).toBeDefined()
  })

  test('closing twice changes nothing: the first outcome is the record', () => {
    const once = closeAttempt(open(freshState('42', 'grok-dev')), 'stopped', { error: 'budget' })
    expect(closeAttempt(once, 'error', { error: 'later' })).toBe(once)
  })

  test('an exception is read as the outcome it stands for', () => {
    expect(outcomeOf(new AgentStopped('cursor agent did not finish within 10 minutes', ''))).toBe('stopped')
    expect(outcomeOf(new Error('Agent made no changes to the code'))).toBe('no-changes')
    expect(outcomeOf(new Error('Guardrail: the change to x is 9 bytes, over maxFileSizeBytes (1)'))).toBe('guardrail')
    expect(outcomeOf(new Error('Guardrails failed:\npackage.json matches blocked pattern'))).toBe('guardrail')
    expect(outcomeOf(new Error('Verification failed: Bundle size (exit 1). Logs are in the execution state.'))).toBe('gate-failed')
    expect(outcomeOf(new Error('git push failed'))).toBe('error')
  })

  test('a retry starts over but keeps the history', () => {
    let state = closeAttempt(open(freshState('42', 'grok-dev')), 'guardrail', { error: 'package.json' })
    state = recordReview(state, { cycle: 1, at: 'now', commitSha: 'abc', durationMs: 301_000, outcome: 'request_changes', votes: [{ agentId: 'codex', agentName: 'Codex', vote: 'reject', execution: 'answered' }] })
    const retried = freshState('42', 'grok-dev', historyOf({ ...state, step: 'failed', error: 'x' }))
    expect(retried.step).toBe('pending')
    expect(retried.error).toBeNull()
    expect(retried.attempts).toHaveLength(1)
    expect(retried.reviews).toHaveLength(1)
    expect(historyOf(null)).toEqual({})
  })

  test('the history reads as a person would tell it', () => {
    let state = open(freshState('42', 'grok-dev'))
    state = recordTurn(state, { durationMs: 747_000, exitCode: 0, reply: 'done' })
    state = recordGate(state, gate({ name: 'Bundle size', output: '  ✗ carousel: 15262 bytes gzipped (budget 15257)' }))
    state = closeAttempt(state, 'gate-failed', { error: 'Verification failed: Bundle size (exit 1). Logs are in the execution state.' })
    state = recordReview(state, { cycle: 1, at: 'now', commitSha: 'abc', durationMs: 301_000, outcome: 'request_changes', votes: [{ agentId: 'codex', agentName: 'Codex', vote: 'reject' }, { agentId: 'gemini', agentName: 'Gemini', vote: 'abstain', execution: 'failed' }] })
    const text = historyText({ ...state, step: 'failed', error: 'Verification failed: Bundle size (exit 1).' }, () => false)
    expect(text).toContain('1. implement · grok-dev (cursor-grok-4.6-high) · turn 12m27s · gate-failed · gate failed at Bundle size · tree gone')
    expect(text).toContain('|   ✗ carousel: 15262 bytes gzipped (budget 15257)')
    expect(text).toContain('cycle 1 · 5m01s · request_changes · Codex reject, Gemini abstain (failed)')
  })
})
