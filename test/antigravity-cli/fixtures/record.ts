#!/usr/bin/env bun
// Fixture: records what it actually received (argv, cwd, and whether stdin was already
// closed) to the file named by AGY_TEST_RECORD, then emits a canned review. Used to
// verify the adapter passes the prompt as a single argv element and closes stdin.
//
// Written as JSON (not simple newline-joined lines like codex-cli's sibling fixture)
// because this adapter's prompt argv element deliberately carries embedded newlines
// (the PROMPT_HEADER prefix — see src/adapter.ts) — a plain `\n`-joined record format
// would silently split that single argv element across multiple recorded "lines" and
// make it unrecoverable from the record file.
import { writeFileSync } from 'node:fs'

const recordPath = process.env.AGY_TEST_RECORD
if (!recordPath) {
  throw new Error('record.ts fixture requires AGY_TEST_RECORD to be set')
}

const TIMEOUT = Symbol('timeout')

let stdin: string
try {
  const result = await Promise.race([
    Bun.stdin.text(),
    new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), 200)),
  ])
  stdin = result === TIMEOUT ? 'open-and-blocking' : result === '' ? 'closed-eof' : `unexpected-data:${result}`
} catch {
  stdin = 'closed-error'
}

const argv = process.argv.slice(2)

writeFileSync(recordPath, JSON.stringify({ argv, cwd: process.cwd(), stdin }))

console.log('Reading repository state...')
console.log('## Reviewer agent (Gemini)')
console.log('Verdict: approve as-is')
