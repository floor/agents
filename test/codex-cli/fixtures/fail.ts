#!/usr/bin/env bun
// Fixture: exits non-zero without ever printing the header — used to test that a
// failed run surfaces as CodexProcessError with the exit code and stderr attached.
// If CODEX_TEST_RECORD is set, records cwd first so a test can later confirm this
// directory was removed after the failure.
import { writeFileSync } from 'node:fs'

if (process.env.CODEX_TEST_RECORD) {
  writeFileSync(process.env.CODEX_TEST_RECORD, `CWD:${process.cwd()}`)
}

console.log('starting analysis...')
console.error('fatal: sandbox denied access to repository')
process.exit(1)
