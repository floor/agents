import { test, expect, describe } from 'bun:test'
import {
  runDeliberation,
  createMockChannel,
  type DeliberationAgent,
  type DeliberationContext,
  type TeamChannel,
  type TeamMessage,
} from '@floor-agents/orchestrator'

const AGENTS: DeliberationAgent[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
]

// A trivial convergence rule: stop when votes are unanimous, else run to the cap.
const unanimous = (cur: Record<string, string>) => {
  const v = Object.values(cur)
  return v.length > 0 && v.every(x => x === v[0]) ? { stop: true, reason: `unanimous ${v[0]}` } : null
}

describe('runDeliberation — channel streaming + human interjection', () => {
  test('streams each turn to the channel', async () => {
    const channel = createMockChannel()
    await runDeliberation<string>({
      agents: AGENTS,
      maxRounds: 1,
      channel,
      review: async (agent) => ({ vote: 'reject', text: `${agent.name} says reject` }),
      converged: () => null,
      summarize: (t) => `${t.vote.toUpperCase()}: ${t.text}`,
    })
    expect(channel.posted).toHaveLength(2)
    expect(channel.posted.map(p => p.from).sort()).toEqual(['Claude', 'Codex'])
    expect(channel.posted[0]!.text).toContain('REJECT')
  })

  test('a human message typed during round 1 folds into round 2 context', async () => {
    const channel = createMockChannel()
    const seen: Record<number, DeliberationContext[]> = { 1: [], 2: [] }

    await runDeliberation<string>({
      agents: AGENTS,
      maxRounds: 2,
      channel,
      review: async (_agent, ctx) => {
        seen[ctx.round]!.push(ctx)
        // The human interjects while round 1 is being produced.
        if (ctx.round === 1) channel.queueHuman('check runway.ts:171 — it writes scrollTop synchronously')
        return { vote: 'reject', text: 'reject' } // never unanimous-approve → runs both rounds
      },
      converged: () => null, // force both rounds
    })

    // Round 1 saw no human messages; round 2 saw the interjection for every agent.
    expect(seen[1]!.every(c => c.humanMessages.length === 0)).toBe(true)
    expect(seen[2]!.length).toBe(2)
    expect(seen[2]!.every(c => c.humanMessages.some(m => m.from === 'Human' && m.text.includes('runway.ts:171')))).toBe(true)
  })

  test('human interjections accumulate (an early constraint persists to later rounds)', async () => {
    const channel = createMockChannel()
    const round3HumanCounts: number[] = []
    await runDeliberation<string>({
      agents: AGENTS,
      maxRounds: 3,
      channel,
      review: async (_agent, ctx) => {
        if (ctx.round === 1) channel.queueHuman('constraint: stay zero-alloc on the hot path')
        if (ctx.round === 3) round3HumanCounts.push(ctx.humanMessages.length)
        return { vote: 'reject', text: 'reject' }
      },
      converged: () => null,
    })
    // The constraint typed at round 1 is still present at round 3.
    expect(round3HumanCounts.every(n => n >= 1)).toBe(true)
  })

  test('round 2 receives the other agent\'s round-1 review as peer context', async () => {
    const peerNamesAtRound2: string[][] = []
    await runDeliberation<string>({
      agents: AGENTS,
      maxRounds: 2,
      review: async (_agent, ctx) => {
        if (ctx.round === 2) peerNamesAtRound2.push(ctx.peers.map(p => p.name))
        return { vote: 'reject', text: 'reject' }
      },
      converged: () => null,
    })
    // Each agent saw exactly the *other* agent as a peer.
    expect(peerNamesAtRound2).toHaveLength(2)
    expect(peerNamesAtRound2.flat().sort()).toEqual(['Claude', 'Codex'])
  })

  test('convergence stops early; result reports rounds + votes', async () => {
    const res = await runDeliberation<string>({
      agents: AGENTS,
      maxRounds: 3,
      review: async () => ({ vote: 'approve', text: 'lgtm' }),
      converged: unanimous,
    })
    expect(res.rounds).toBe(1)
    expect(res.stopReason).toContain('unanimous')
    expect(res.votesByAgent).toEqual({ claude: 'approve', codex: 'approve' })
  })

  test('works with no channel (channel is optional)', async () => {
    const res = await runDeliberation<string>({
      agents: AGENTS,
      maxRounds: 1,
      review: async () => ({ vote: 'reject', text: 'no' }),
      converged: () => null,
    })
    expect(res.turns).toHaveLength(2)
    expect(res.humanInterjections).toHaveLength(0)
  })

  test('a channel outage does not kill a run that has already cost money', async () => {
    const exploding: TeamChannel = {
      async post(): Promise<void> { throw new Error('telegram down') },
      async drainHumanMessages(): Promise<TeamMessage[]> { throw new Error('telegram down') },
    }
    const errors: string[] = []
    const res = await runDeliberation<string>({
      agents: AGENTS,
      maxRounds: 2,
      channel: exploding,
      review: async () => ({ vote: 'reject', text: 'reject' }),
      converged: () => null,
      onChannelError: (m) => errors.push(m),
    })
    expect(res.rounds).toBe(2)          // both rounds still completed
    expect(res.turns).toHaveLength(2)
    // ...and the outage was reported rather than swallowed.
    expect(errors.some(e => e.includes('telegram down'))).toBe(true)
  })

  test('a failing onTurn IS fatal — the durable record must not fail quietly', async () => {
    // Deliberate asymmetry: the channel is a window, onTurn is the system of record.
    await expect(
      runDeliberation<string>({
        agents: AGENTS,
        maxRounds: 1,
        review: async () => ({ vote: 'reject', text: 'reject' }),
        converged: () => null,
        onTurn: async () => { throw new Error('github write failed') },
      }),
    ).rejects.toThrow('github write failed')
  })

  // parseInt('three') is NaN, and `round <= NaN` is false: the loop ran zero rounds
  // and the caller published an empty consensus as though the committee had met.
  for (const cap of [Number.NaN, 0, -1, 2.5]) {
    test(`refuses a round cap of ${cap} instead of running no round`, async () => {
      let reviewed = 0
      await expect(
        runDeliberation<string>({
          agents: AGENTS,
          maxRounds: cap,
          review: async () => { reviewed++; return { vote: 'reject', text: 'reject' } },
          converged: () => null,
        }),
      ).rejects.toThrow(/maxRounds must be a positive whole number/)
      expect(reviewed).toBe(0)
    })
  }
})
