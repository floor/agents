import { describe, expect, test } from 'bun:test'
import { extractVote, voteMarkers } from '../../packages/orchestrator/src/vote.ts'

describe('extractVote', () => {
  test('the last marker is the vote: a quoted approval before a rejection is a rejection', () => {
    // Codex on floor/vlist#250, recorded as APPROVE by the first-marker parser.
    const review = [
      'The implementation correctly rejects partial output on `is_error`.',
      'A partial `VOTE: APPROVE` is insufficient evidence of a completed review.',
      '',
      '**VOTE: REJECT**',
    ].join('\n')
    expect(extractVote(review)).toBe('reject')
  })

  test('a marker inside a fenced block is an example, not a vote', () => {
    const review = 'A response could read:\n\n```text\nBLOCKER: x\nVOTE: REJECT\n```\n\nNothing blocks this.\n\n**VOTE: APPROVE**'
    expect(extractVote(review)).toBe('approve')
    expect(voteMarkers(review)).toEqual(['approve'])
  })

  test('a reviewer that changes its mind is read at its last word, and both are visible', () => {
    const review = 'VOTE: APPROVE\n\nOn reflection the second finding stands.\n\nVOTE: REJECT'
    expect(voteMarkers(review)).toEqual(['approve', 'reject'])
    expect(extractVote(review)).toBe('reject')
  })

  test('the ways reviewers say no', () => {
    for (const text of ['VOTE: REQUEST_CHANGES', 'Vote: request changes', '**Vote:** CHANGES REQUESTED', 'VOTE: REJECTED', 'vote: reject']) {
      expect(extractVote(text)).toBe('reject')
    }
  })

  test('the ways reviewers say yes, with markdown around the word', () => {
    for (const text of ['VOTE: APPROVE', '**VOTE: APPROVE**', '**Vote:** APPROVE', 'Vote: **approved**']) {
      expect(extractVote(text)).toBe('approve')
    }
  })

  test('no marker, an empty answer, or an unknown word is an abstention', () => {
    expect(extractVote('Looks fine to me.')).toBe('abstain')
    expect(extractVote('')).toBe('abstain')
    expect(extractVote('VOTE: MAYBE')).toBe('abstain')
  })
})
