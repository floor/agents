#!/usr/bin/env bun
/**
 * Discussion watcher — the auto-trigger for the deliberative committee.
 *
 * Polls one or more GitHub Discussions and, whenever an RFC **body** changes
 * (a new revision — not a new comment), launches the deliberative committee on
 * it automatically. This is the event source for the committee: editing the RFC
 * in the discussion is the trigger, no manual run.
 *
 * Keys on a hash of the discussion BODY, so the committee's own comments (which
 * bump the discussion's updatedAt) never re-trigger it — only a real edit does.
 *
 *   WATCH_DISCUSSIONS=117 CODEX_CWD=~/Code/floor/vlist AGENTS=claude,codex,grok \
 *   POLL_INTERVAL_MS=15000 bun scripts/discussion-watch.ts
 *
 * On startup it SEEDS the current body hashes without triggering (so it reacts to
 * changes from now on). Set TRIGGER_ON_START=1 to review the current state once.
 */

import { createDiscussionsAdapter, type DiscussionsAdapter } from '@floor-agents/github'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

const OWNER = process.env.REPO_OWNER ?? 'floor'
const REPO = process.env.REPO_NAME ?? 'vlist'
const WATCH = (process.env.WATCH_DISCUSSIONS ?? '117')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10)
const TRIGGER_ON_START = process.env.TRIGGER_ON_START === '1'
const STATE_DIR = join(homedir(), '.floor-committee')
const STATE_FILE = join(STATE_DIR, 'discussion-watch.json')

async function githubToken(): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const proc = Bun.spawn(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'pipe' })
  const token = (await new Response(proc.stdout).text()).trim()
  if ((await proc.exited) !== 0 || !token) throw new Error('no GITHUB_TOKEN and `gh auth token` failed')
  return token
}

const bodyHash = (s: string): string => String(Bun.hash(s))

async function loadState(): Promise<Record<string, string>> {
  try { return await Bun.file(STATE_FILE).json() } catch { return {} }
}
async function saveState(state: Record<string, string>): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
}

let busy = false

async function runCommittee(num: number): Promise<void> {
  busy = true
  console.log(`[watch] body of #${num} changed → launching committee`)
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'discussion-committee.ts')], {
    env: { ...process.env, DISCUSSION: String(num) },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  console.log(`[watch] committee for #${num} finished (exit ${code})`)
  busy = false
}

async function main() {
  const discussions: DiscussionsAdapter = createDiscussionsAdapter({
    token: await githubToken(), owner: OWNER, repo: REPO,
  })
  const state = await loadState()

  console.log(`[watch] watching ${OWNER}/${REPO} discussions ${WATCH.join(', ')} every ${POLL_MS / 1000}s`)

  // Seed current hashes on first sight so only future edits trigger (unless asked).
  for (const num of WATCH) {
    const d = await discussions.getDiscussion(num)
    if (!d) { console.error(`[watch] #${num} not found`); continue }
    const h = bodyHash(d.body)
    if (state[num] === undefined && !TRIGGER_ON_START) {
      state[num] = h
      console.log(`[watch] seeded #${num} "${d.title}" (will trigger on the next edit)`)
    }
  }
  await saveState(state)

  // Poll loop.
  for (;;) {
    if (!busy) {
      for (const num of WATCH) {
        try {
          const d = await discussions.getDiscussion(num)
          if (!d) continue
          const h = bodyHash(d.body)
          if (state[num] !== h) {
            await runCommittee(num)
            state[num] = h           // record AFTER the run so a crash re-triggers
            await saveState(state)
          }
        } catch (err) {
          console.error(`[watch] #${num}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

main().catch((err) => { console.error('[watch] fatal:', err); process.exit(1) })
