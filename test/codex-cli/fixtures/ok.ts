#!/usr/bin/env bun
// Fixture: a canned Codex run that succeeds — a progress log, then the review,
// headed by the exact marker the adapter looks for.
console.log('Reading repository state...')
console.log('Cross-referencing changed files against the diff...')
console.log('## Reviewer agent (Codex)')
console.log('')
console.log('Reviewed commit abc1234.')
console.log('')
console.log('Verdict: approve as-is')
