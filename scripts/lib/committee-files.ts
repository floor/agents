/**
 * Shared file protocol for the Antigravity committee bridge.
 *
 * The persistent relay (gateway side) and the file-backed MCP server (Antigravity
 * side) communicate through a directory of plain files so their process lifecycles
 * are fully decoupled:
 *
 *   pending/<sid>.json        the TaskAssignment        (relay writes, MCP reads)
 *   pending/<sid>.announced   notifier dedup marker     (notify writes, relay clears)
 *   results/<sid>.json        { taskId, content }       (MCP writes, relay forwards)
 *
 * `<sid>` is the gateway task id with non-[A-Za-z0-9._-] chars replaced by `_`.
 */
import {
  mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, statSync, renameSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type PendingTask = {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly systemPrompt: string
}

export const DEFAULT_BASE = join(homedir(), '.floor-committee')

/** Filesystem-safe form of a gateway task id (used as the file stem). */
export const safe = (id: string): string => id.replace(/[^a-zA-Z0-9._-]/g, '_')

export type CommitteeFiles = ReturnType<typeof committeeFiles>

/** Open (creating if needed) the committee file store rooted at `base`. */
export function committeeFiles(base: string = DEFAULT_BASE) {
  const pending = join(base, 'pending')
  const results = join(base, 'results')
  mkdirSync(pending, { recursive: true })
  mkdirSync(results, { recursive: true })

  return {
    base, pending, results,

    /** Record an assignment as pending. Returns its safe id. */
    writePending(task: PendingTask): string {
      const sid = safe(task.id)
      writeFileSync(join(pending, `${sid}.json`), JSON.stringify(task))
      return sid
    },

    /** The oldest pending review (by mtime), or null. */
    oldestPending(): PendingTask | null {
      const files = readdirSync(pending).filter(f => f.endsWith('.json'))
      if (files.length === 0) return null
      files.sort((a, b) => statSync(join(pending, a)).mtimeMs - statSync(join(pending, b)).mtimeMs)
      try {
        return JSON.parse(readFileSync(join(pending, files[0]!), 'utf8')) as PendingTask
      } catch {
        return null
      }
    },

    /** Safe ids of all pending reviews. */
    pendingSids(): string[] {
      return readdirSync(pending).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
    },

    isAnnounced(sid: string): boolean {
      return existsSync(join(pending, `${sid}.announced`))
    },

    /** Mark a review announced. Returns true only on the first call (dedup). */
    announce(sid: string): boolean {
      const marker = join(pending, `${sid}.announced`)
      if (existsSync(marker)) return false
      writeFileSync(marker, '')
      return true
    },

    /** Record a vote for a task id (atomic: tmp + rename). */
    writeResult(taskId: string, content: string): void {
      const sid = safe(taskId)
      const tmp = join(results, `${sid}.json.tmp`)
      writeFileSync(tmp, JSON.stringify({ taskId, content }))
      renameSync(tmp, join(results, `${sid}.json`))
    },

    /** Parse a result file by name, or null if absent / mid-write. */
    readResult(name: string): { taskId: string; content: string } | null {
      if (!name.endsWith('.json')) return null
      try {
        return JSON.parse(readFileSync(join(results, name), 'utf8')) as { taskId: string; content: string }
      } catch {
        return null
      }
    },

    /** Names of all result files awaiting forward. */
    resultFiles(): string[] {
      return readdirSync(results).filter(f => f.endsWith('.json'))
    },

    /** Remove all files for a review (pending, marker, result). */
    clear(sid: string): void {
      rmSync(join(pending, `${sid}.json`), { force: true })
      rmSync(join(pending, `${sid}.announced`), { force: true })
      rmSync(join(results, `${sid}.json`), { force: true })
    },
  }
}
