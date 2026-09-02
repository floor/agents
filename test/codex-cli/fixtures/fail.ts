#!/usr/bin/env bun
// Fixture: exits non-zero without ever printing the header — used to test that a
// failed run surfaces as CodexProcessError with the exit code and stderr attached.
console.log('starting analysis...')
console.error('fatal: sandbox denied access to repository')
process.exit(1)
