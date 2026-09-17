/**
 * The team channel — a shared communication bus where agents speak, the human
 * watches in real time, and the human can interject as a participant.
 *
 * It is the *nerve and window*, not the system of record: agents still pass their
 * work over the gateway and persist outcomes durably (GitHub/file); the channel
 * carries a concise, live stream and pulls in human messages between rounds.
 *
 * Telegram is the intended real implementation (group chat, author-prefixed,
 * allowlisted, inline approve/reject). This module defines the interface and a
 * mock so the deliberation wiring is testable without any credentials.
 */

export type TeamMessage = {
  /** Display name of the speaker — an agent ("Codex"), the orchestrator, or "Human". */
  readonly from: string
  readonly text: string
}

export type Decision = {
  readonly approved: boolean
  readonly note?: string
}

export type TeamChannel = {
  /** An agent or the orchestrator speaks; streamed to the channel surface. */
  post(from: string, text: string): Promise<void>
  /** Pull human interjections received since the last drain (then clear them). */
  drainHumanMessages(): Promise<TeamMessage[]>
  /** Optional approval gate (inline buttons in a real channel). */
  awaitDecision?(taskId: string, prompt: string): Promise<Decision>
}

export type MockChannel = TeamChannel & {
  /** Everything agents/orchestrator posted, in order. */
  readonly posted: ReadonlyArray<TeamMessage>
  /** Simulate the human typing into the channel (picked up on the next drain). */
  queueHuman(text: string, from?: string): void
}

/** In-memory channel for tests: records posts, lets a test inject human messages. */
export function createMockChannel(): MockChannel {
  const posted: TeamMessage[] = []
  let pending: TeamMessage[] = []
  return {
    posted,
    queueHuman(text: string, from = 'Human'): void {
      pending.push({ from, text })
    },
    async post(from: string, text: string): Promise<void> {
      posted.push({ from, text })
    },
    async drainHumanMessages(): Promise<TeamMessage[]> {
      const drained = pending
      pending = []
      return drained
    },
  }
}
