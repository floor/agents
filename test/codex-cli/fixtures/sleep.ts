#!/usr/bin/env bun
// Fixture: never finishes within any reasonable test timeout — used to test that the
// adapter kills the process (with SIGKILL, since this ignores SIGTERM) and throws
// CodexTimeoutError. If CODEX_TEST_RECORD is set, records cwd first so a test can
// later confirm this directory was removed after the timeout.
import { writeFileSync } from 'node:fs'

if (process.env.CODEX_TEST_RECORD) {
  writeFileSync(process.env.CODEX_TEST_RECORD, `CWD:${process.cwd()}`)
}

// Prove the adapter's timeout kill is not just a SIGTERM a real codex hang could
// ignore: this process ignores SIGTERM outright, so only SIGKILL can end it.
process.on('SIGTERM', () => {})

console.log('starting analysis...')
await Bun.sleep(30_000)
console.log('## Reviewer agent (Codex)')
console.log('Verdict: approve as-is')
