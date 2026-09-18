import { describe, expect, test } from 'bun:test'
import type { ReviewRecord } from '@floor-agents/core'
import { similarity, standingBlockers, STANDING_THRESHOLD } from '../../packages/orchestrator/src/standing-blockers.ts'
import { extractBlockers } from '../../packages/orchestrator/src/committee-pr-review.ts'

// The blockers as they were written, 2026-09-18.
const MTRL = [
  'Preserve the existing 0.9.x contract or move the behavior change to the next major release.',
  'Preserve the existing 0.9.x behavior; move the proposed default behavior change to the next major release.',
  'Preserve the existing behavior in 0.9.x, or move this behavior change to the next major release and explicitly document the migration.',
]
const VLIST = [
  'Validate the groups callback against the inferred item type at `createVListFromConfig`.',
  'Give inline factory callbacks the inferred item type instead of `any`.',
  'Validate callbacks when `groups` is optional in the input type.',
  'The CHANGELOG must record the type-level breaks.',
  'the adapter call path now returns `VList<any>`',
  '`NoInfer` does nothing, leaks into public types, and raises the TypeScript floor',
]

describe('similarity', () => {
  test('the same blocker in three wordings is recognised (mtrl #92)', () => {
    expect(similarity(MTRL[0]!, MTRL[1]!)).toBeGreaterThanOrEqual(STANDING_THRESHOLD)
    expect(similarity(MTRL[1]!, MTRL[2]!)).toBeGreaterThanOrEqual(STANDING_THRESHOLD)
    expect(similarity(MTRL[0]!, MTRL[2]!)).toBeGreaterThanOrEqual(STANDING_THRESHOLD)
  })

  test('successive, different blockers on one change are not (vlist #260)', () => {
    for (let i = 0; i < VLIST.length; i++) {
      for (let j = i + 1; j < VLIST.length; j++) {
        expect(similarity(VLIST[i]!, VLIST[j]!)).toBeLessThan(STANDING_THRESHOLD)
      }
    }
  })

  test('nothing in common with nothing', () => {
    expect(similarity('', MTRL[0]!)).toBe(0)
    expect(similarity('a of to', 'a of to')).toBe(0) // no significant word: no evidence
  })
})

describe('standingBlockers', () => {
  const previous = (over: Partial<ReviewRecord> = {}): ReviewRecord => ({
    cycle: 1, at: '2026-09-18T20:40:00Z', commitSha: 'before', durationMs: 1, outcome: 'request_changes',
    votes: [
      { agentId: 'claude', agentName: 'Claude', vote: 'reject', blockers: ['Remove the `aria-checked` writes.'] },
      { agentId: 'codex', agentName: 'Codex', vote: 'reject', blockers: [MTRL[0]!] },
    ],
    ...over,
  })
  const codexAgain = [{ agentId: 'codex', agentName: 'Codex', blockers: [MTRL[1]!] }]

  test('a member that repeats its blocker after a revision is named, with both wordings', () => {
    expect(standingBlockers(previous(), codexAgain, 'after')).toEqual([
      { agentId: 'codex', agentName: 'Codex', blocker: MTRL[1]!, earlier: MTRL[0]! },
    ])
  })

  test('another member raising a similar point is a second opinion, not a repeat', () => {
    expect(standingBlockers(previous(), [{ agentId: 'gemini', agentName: 'Gemini', blockers: [MTRL[1]!] }], 'after')).toEqual([])
  })

  test('a new blocker from the same member is not standing', () => {
    expect(standingBlockers(previous(), [{ agentId: 'codex', agentName: 'Codex', blockers: [VLIST[3]!] }], 'after')).toEqual([])
  })

  test('reopened after a stop, the same commit, the same blocker again: it still stands', () => {
    const stopped = previous({ commitSha: 'after', standing: [`Codex: ${MTRL[0]}`] })
    expect(standingBlockers(stopped, codexAgain, 'after')).toHaveLength(1)
  })

  test('no revision in between, no verdict before, or no previous review: nothing stands', () => {
    expect(standingBlockers(previous(), codexAgain, 'before')).toEqual([]) // the same commit judged twice
    expect(standingBlockers(previous({ outcome: 'no_decision' }), codexAgain, 'after')).toEqual([])
    expect(standingBlockers(undefined, codexAgain, 'after')).toEqual([])
  })
})

describe('extractBlockers', () => {
  test('reads the forms reviewers actually write', () => {
    const review = [
      '**BLOCKER: Validate the callback.**',
      'BLOCKER: plain line',
      '## BLOCKER 1: the adapter call path now returns `VList<any>`',
      '### BLOCKER 2: `NoInfer` does nothing',
      '- BLOCKER: a bullet',
      '**BLOCKER 3:** numbered and bold',
    ].join('\n')
    expect(extractBlockers(review)).toEqual([
      'Validate the callback.',
      'plain line',
      'the adapter call path now returns `VList<any>`',
      '`NoInfer` does nothing',
      'a bullet',
      'numbered and bold',
    ])
  })

  test('a reviewer saying there is none has raised none', () => {
    expect(extractBlockers('BLOCKER: none\n**BLOCKER:** None.\nBLOCKER: N/A\nBLOCKER: no blockers')).toEqual([])
    expect(extractBlockers('BLOCKER: no test covers toggle()')).toEqual(['no test covers toggle()'])
  })

  test('prose that mentions blockers is not one', () => {
    expect(extractBlockers('I found no blockers.\nThere is no BLOCKER here\n## Blockers')).toEqual([])
  })
})
