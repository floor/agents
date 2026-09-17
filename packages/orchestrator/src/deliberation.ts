/**
 * Channel-aware deliberation loop — the reusable committee core.
 *
 * Runs multi-round deliberation over a set of agents: round 1 each reviews
 * independently; round N each receives the others' prior-round reviews **and any
 * human interjections** as context, and may revise. It streams each turn to a
 * TeamChannel (so the human watches live) and, between rounds, folds in whatever
 * the human typed (so the human can steer mid-deliberation).
 *
 * Agent-agnostic: the caller supplies `review` (how an agent produces a turn) and
 * `converged` (when to stop). The same loop backs the GitHub committee, the A/B
 * decision committee, and the orchestrator — only the callbacks differ.
 */

import type { TeamChannel, TeamMessage } from './team-channel.ts'

export type DeliberationAgent = { readonly id: string; readonly name: string }

export type DeliberationContext = {
  readonly round: number
  /** Other agents' reviews from the previous round. */
  readonly peers: ReadonlyArray<{ readonly name: string; readonly text: string }>
  /** Human interjections so far (accumulated), so a constraint typed early persists. */
  readonly humanMessages: ReadonlyArray<TeamMessage>
}

export type Turn<V> = {
  readonly agent: DeliberationAgent
  readonly round: number
  readonly vote: V
  readonly text: string
}

export type ConvergenceResult = { readonly stop: boolean; readonly reason: string }

export type DeliberationOptions<V> = {
  readonly agents: ReadonlyArray<DeliberationAgent>
  readonly maxRounds: number
  /** Produce one agent's turn for a round, given peers + human context. */
  readonly review: (agent: DeliberationAgent, ctx: DeliberationContext) => Promise<{ vote: V; text: string }>
  /** Decide whether to stop after a round (unanimous / stable / etc.). */
  readonly converged: (
    current: Readonly<Record<string, V>>,
    previous: Readonly<Record<string, V>> | null,
    round: number,
  ) => ConvergenceResult | null
  /** Optional shared channel — turns are streamed here; human messages drained from it. */
  readonly channel?: TeamChannel
  /** Concise text to stream per turn (defaults to the full review text). */
  readonly summarize?: (turn: Turn<V>) => string
  /** Side effects per turn (e.g. post the full review to GitHub). */
  readonly onTurn?: (turn: Turn<V>) => Promise<void>
  /**
   * Reports a channel failure that was swallowed to keep the run alive.
   * Defaults to `console.warn` — a chat outage must be visible, never silent.
   */
  readonly onChannelError?: (message: string) => void
}

/**
 * Run a channel operation without letting it kill the deliberation.
 *
 * The channel is the window, not the system of record (see team-channel.ts): a chat
 * outage must not abort a run that has already spent real money on completed rounds.
 * `onTurn` is deliberately NOT wrapped — that one persists the durable record, so it
 * should fail loudly rather than leave an incomplete transcript behind.
 */
async function safely<T>(
  op: () => Promise<T>,
  fallback: T,
  what: string,
  onError: (message: string) => void,
): Promise<T> {
  try {
    return await op()
  } catch (err) {
    onError(`channel ${what} failed (continuing): ${err instanceof Error ? err.message : String(err)}`)
    return fallback
  }
}

export type DeliberationResult<V> = {
  /** The final round's turns. */
  readonly turns: ReadonlyArray<Turn<V>>
  readonly rounds: number
  readonly stopReason: string
  readonly votesByAgent: Readonly<Record<string, V>>
  readonly humanInterjections: ReadonlyArray<TeamMessage>
}

export async function runDeliberation<V>(opts: DeliberationOptions<V>): Promise<DeliberationResult<V>> {
  const { agents, maxRounds, review, converged, channel, summarize, onTurn } = opts
  const onChannelError = opts.onChannelError ?? ((msg: string) => console.warn(`[deliberation] ${msg}`))

  let previous: Record<string, V> | null = null
  let last: Turn<V>[] = []
  let stopReason = `reached the ${maxRounds}-round cap`
  const allHuman: TeamMessage[] = []

  for (let round = 1; round <= maxRounds; round++) {
    // Pull whatever the human typed since the last round so it informs this one.
    if (channel) {
      allHuman.push(...(await safely(() => channel.drainHumanMessages(), [], 'drainHumanMessages', onChannelError)))
    }
    const humanMessages: ReadonlyArray<TeamMessage> = [...allHuman]

    const turns = await Promise.all(
      agents.map(async (agent): Promise<Turn<V>> => {
        const peers = last
          .filter(t => t.agent.id !== agent.id)
          .map(t => ({ name: t.agent.name, text: t.text }))
        const { vote, text } = await review(agent, { round, peers, humanMessages })
        return { agent, round, vote, text }
      }),
    )

    for (const turn of turns) {
      if (onTurn) await onTurn(turn)
      if (channel) {
        const text = summarize ? summarize(turn) : turn.text
        await safely(() => channel.post(turn.agent.name, text), undefined, 'post', onChannelError)
      }
    }

    last = turns
    const votes: Record<string, V> = {}
    for (const t of turns) votes[t.agent.id] = t.vote

    const conv = converged(votes, previous, round)
    previous = votes
    if (conv?.stop) {
      return { turns: last, rounds: round, stopReason: conv.reason, votesByAgent: votes, humanInterjections: allHuman }
    }
  }

  const votes: Record<string, V> = {}
  for (const t of last) votes[t.agent.id] = t.vote
  return { turns: last, rounds: maxRounds, stopReason, votesByAgent: votes, humanInterjections: allHuman }
}
