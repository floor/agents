/** Wake-notifier core: announce each pending review exactly once. */
import { watch } from 'node:fs'
import type { CommitteeFiles } from './committee-files.ts'

/**
 * Announce every not-yet-announced pending review, calling `emit(sid)` for each.
 * The `.announced` marker (written by `announce`) makes this idempotent across
 * restarts — a review is emitted exactly once even if the notifier is cycled.
 */
export function scanAndAnnounce(files: CommitteeFiles, emit: (sid: string) => void): void {
  for (const sid of files.pendingSids()) {
    if (files.announce(sid)) emit(sid)
  }
}

/** Start watching for pending reviews; returns a stop handle. */
export function createNotifier(
  files: CommitteeFiles,
  emit: (sid: string) => void,
  intervalMs = 1000,
): { stop(): void } {
  const run = () => scanAndAnnounce(files, emit)
  run()
  let watcher: ReturnType<typeof watch> | null = null
  try { watcher = watch(files.pending, () => run()) } catch { /* interval covers it */ }
  const timer = setInterval(run, intervalMs)
  return { stop() { watcher?.close(); clearInterval(timer) } }
}
