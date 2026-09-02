#!/usr/bin/env bun
// Fixture: records what it actually received (argv, cwd, and whether stdin was already
// closed) to the file named by CODEX_TEST_RECORD, then emits a canned review. Used to
// verify the adapter passes the prompt as a single argv element and closes stdin.
import { writeFileSync } from 'node:fs'

const recordPath = process.env.CODEX_TEST_RECORD
if (!recordPath) {
  throw new Error('record.ts fixture requires CODEX_TEST_RECORD to be set')
}

const TIMEOUT = Symbol('timeout')

let stdinState: string
try {
  const result = await Promise.race([
    Bun.stdin.text(),
    new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), 200)),
  ])
  stdinState = result === TIMEOUT ? 'open-and-blocking' : result === '' ? 'closed-eof' : `unexpected-data:${result}`
} catch {
  stdinState = 'closed-error'
}

const args = process.argv.slice(2)
const lines = [`ARGC:${args.length}`, ...args.map((arg) => `ARG:${arg}`), `CWD:${process.cwd()}`, `STDIN:${stdinState}`]

writeFileSync(recordPath, lines.join('\n'))

console.log('Reading repository state...')
console.log('## Reviewer agent (Codex)')
console.log('Verdict: approve as-is')
