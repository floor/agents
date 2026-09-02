// Per-PR persisted gate state, keyed by repo + PR number. Reuses the same
// atomic-write pattern as packages/orchestrator/src/state-store.ts
// (write to a .tmp file, then rename) so a crash mid-write never leaves a
// half-written, corrupt state file.

import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { GateDecision } from './decision.ts'

export type GatePrState = {
  readonly repo: string
  readonly prNumber: string
  readonly headSha: string
  readonly decisionKind: GateDecision['kind']
  readonly reason: string | null
  /** Set once a squash-merge for this head has actually been issued, so a
   *  later poll (before GitHub's PR list catches up) never re-merges. */
  readonly merged: boolean
  /** Head sha -> vendors that have been ASKED to review it (Reviewer.review()
   *  was called for that vendor on that head), regardless of what happened
   *  to the result afterward — a malformed response, a deleted comment, or
   *  a since-changed trustedReviewers mapping must never cause a repeat
   *  review of the same head. This is the loop's own dedup record, kept
   *  deliberately separate from decideGate()'s live view of currently
   *  valid/trusted verdict comments. */
  readonly reviewedHeads: Readonly<Record<string, readonly string[]>>
  readonly updatedAt: string
}

export type GateStateStore = {
  get(repo: string, prNumber: string): Promise<GatePrState | null>
  save(state: GatePrState): Promise<void>
}

function fileNameFor(repo: string, prNumber: string): string {
  // repo is "owner/name" — flatten the slash so it's a single filename component.
  return `${repo.replace(/\//g, '__')}__${prNumber}.json`
}

export function createGateStateStore(dir: string): GateStateStore {
  return {
    async get(repo, prNumber) {
      const path = join(dir, fileNameFor(repo, prNumber))
      const file = Bun.file(path)

      if (!await file.exists()) return null

      try {
        return await file.json() as GatePrState
      } catch {
        console.error(`[gate] corrupt state file: ${path}`)
        return null
      }
    },

    async save(state) {
      await mkdir(dir, { recursive: true })
      const name = fileNameFor(state.repo, state.prNumber)
      const tmpPath = join(dir, `${name}.tmp`)
      const finalPath = join(dir, name)

      const updated: GatePrState = { ...state, updatedAt: new Date().toISOString() }

      await Bun.write(tmpPath, JSON.stringify(updated, null, 2))
      await rename(tmpPath, finalPath)
    },
  }
}
