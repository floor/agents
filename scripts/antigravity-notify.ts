#!/usr/bin/env bun
/**
 * Antigravity wake notifier — run this as a background task INSIDE Antigravity.
 *
 * It watches the pending/ dir the relay writes to and prints NEW_REVIEW to stdout
 * (which wakes Antigravity). Stateless and safe to be cycled/restarted: a per-review
 * `.announced` marker guarantees each review wakes Antigravity exactly once.
 *
 * Logic lives in lib/notify.ts (testable); this is the runnable entry point.
 *
 *   bun /Users/jvial/Code/floor/agents/scripts/antigravity-notify.ts
 *
 * Standing rule: on each NEW_REVIEW line, call get_pending_review, review the RFC
 * as a browser-engine expert, then call submit_vote.
 */
import { committeeFiles } from './lib/committee-files.ts'
import { createNotifier } from './lib/notify.ts'

const files = committeeFiles()
createNotifier(files, (sid) => process.stdout.write(`NEW_REVIEW ${sid}\n`))
