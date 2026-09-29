/**
 * The default policies are today's rules: for every ballot, `decide` with the
 * default `pr-review` policy agrees with `tallyCommitteePrReview`, and with the
 * default `rfc` policy agrees with `tallyVotes`.
 */

import { test, expect, describe } from 'bun:test'
import { decide, DEFAULT_DECISIONS } from '@floor-agents/core'
import type { DecisionResult, Verdict } from '@floor-agents/core'
import { tallyCommitteePrReview, tallyVotes, extractBlockers } from '@floor-agents/orchestrator'
import type { CommitteeVote, Vote } from '@floor-agents/orchestrator'

const VOTES: readonly Vote[] = ['approve', 'reject', 'abstain']
const EXECUTIONS = ['answered', 'failed'] as const
const RESPONSES = [
  '',
  'Looks correct.\n\nVOTE: APPROVE',
  '**BLOCKER: the cache is never cleared**',
  '## BLOCKER 1: missing test\n- BLOCKER 2: wrong default',
  'BLOCKER: none',
  'I have concerns but nothing blocking.',
] as const

/**
 * A committee vote as a verdict, the way the wiring will pass it: a failed
 * seat is heard with no blockers (its error text is not a review), and a
 * REJECT that lists none still carries one — as `memberBlockers` gives it.
 */
function toVerdict(v: CommitteeVote): Verdict {
  const decision = v.vote === 'approve' ? 'approve' : v.vote === 'reject' ? 'changes' : 'abstain'
  if (v.execution === 'failed') return { agent: v.agentId, decision, blockers: [] }
  let blockers = extractBlockers(v.response || v.summary)
  if (!blockers.length && v.vote === 'reject') {
    const text = (v.summary || v.response).trim()
    blockers = [text || `${v.agentName} voted REJECT`]
  }
  return { agent: v.agentId, decision, blockers }
}

function vote(i: number, v: Vote, execution: CommitteeVote['execution'], response: string, summary = ''): CommitteeVote {
  return { agentId: `a${i}`, agentName: `Agent ${i}`, vote: v, summary, response, costUsd: 0, execution }
}

const PR_RESULT: Record<string, DecisionResult> = { approve: 'approve', request_changes: 'changes', no_decision: 'no-decision' }
const RFC_RESULT: Record<string, DecisionResult> = { approved: 'approve', rejected: 'changes', no_quorum: 'no-decision' }

function prDecision(votes: CommitteeVote[]): DecisionResult {
  return decide({ kind: 'pr-review', policy: DEFAULT_DECISIONS['pr-review']!, verdicts: votes.map(toVerdict) }).result
}

function rfcDecision(votes: CommitteeVote[]): DecisionResult {
  return decide({ kind: 'rfc', policy: DEFAULT_DECISIONS['rfc']!, verdicts: votes.map(toVerdict) }).result
}

/** Deterministic, so a failure reproduces. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!
}

/** Every seat shape: vote × execution × {no blocker, a blocker}. */
const SEATS = VOTES.flatMap(v => EXECUTIONS.flatMap(e => [RESPONSES[0], RESPONSES[2]].map(r => ({ v, e, r }))))

function* exhaustiveBallots(maxSeats: number): Generator<CommitteeVote[]> {
  function* build(prefix: CommitteeVote[]): Generator<CommitteeVote[]> {
    yield prefix
    if (prefix.length === maxSeats) return
    for (const s of SEATS) yield* build([...prefix, vote(prefix.length, s.v, s.e, s.r)])
  }
  yield* build([])
}

function randomBallots(count: number, seed: number): CommitteeVote[][] {
  const rand = mulberry32(seed)
  const ballots: CommitteeVote[][] = []
  for (let n = 0; n < count; n++) {
    const seats = Math.floor(rand() * 8)
    ballots.push(Array.from({ length: seats }, (_, i) => vote(
      i,
      pick(rand, VOTES),
      rand() < 0.2 ? 'failed' : 'answered',
      pick(rand, RESPONSES),
      rand() < 0.5 ? pick(rand, RESPONSES) : '',
    )))
  }
  return ballots
}

describe('default pr-review policy = tallyCommitteePrReview', () => {
  test('every ballot of up to 4 seats', () => {
    let checked = 0
    for (const ballot of exhaustiveBallots(4)) {
      const expected = PR_RESULT[tallyCommitteePrReview(ballot).outcome]
      const actual = prDecision(ballot)
      if (actual !== expected) throw new Error(`Mismatch on ${JSON.stringify(ballot)}: decide ${actual}, tally ${expected}`)
      checked++
    }
    expect(checked).toBeGreaterThan(20_000)
  })

  test('5000 random ballots of up to 7 seats with mixed review text', () => {
    for (const ballot of randomBallots(5000, 0xf100)) {
      expect(prDecision(ballot)).toBe(PR_RESULT[tallyCommitteePrReview(ballot).outcome]!)
    }
  })

  test('each outcome is reached, so the agreement is not vacuous', () => {
    const seen = new Set(randomBallots(2000, 7).map(prDecision))
    expect([...seen].sort()).toEqual(['approve', 'changes', 'no-decision'])
  })
})

describe('default rfc policy = tallyVotes', () => {
  test('every ballot of up to 4 seats', () => {
    for (const ballot of exhaustiveBallots(4)) {
      const expected = RFC_RESULT[tallyVotes(ballot)]
      const actual = rfcDecision(ballot)
      if (actual !== expected) throw new Error(`Mismatch on ${JSON.stringify(ballot)}: decide ${actual}, tally ${expected}`)
    }
  })

  test('5000 random ballots', () => {
    for (const ballot of randomBallots(5000, 0xbeef)) {
      expect(rfcDecision(ballot)).toBe(RFC_RESULT[tallyVotes(ballot)]!)
    }
  })

  test('each outcome is reached', () => {
    const seen = new Set(randomBallots(2000, 11).map(rfcDecision))
    expect([...seen].sort()).toEqual(['approve', 'changes', 'no-decision'])
  })
})
