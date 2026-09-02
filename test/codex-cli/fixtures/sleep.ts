#!/usr/bin/env bun
// Fixture: never finishes within any reasonable test timeout — used to test that the
// adapter kills the process and throws CodexTimeoutError.
console.log('starting analysis...')
await Bun.sleep(30_000)
console.log('## Reviewer agent (Codex)')
console.log('Verdict: approve as-is')
