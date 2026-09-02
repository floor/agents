#!/usr/bin/env bun
// Fixture: a canned Antigravity run that succeeds — a progress log, then the review,
// headed by the exact marker the adapter looks for.
console.log('Reading repository state...')
console.log('Cross-referencing changed files against the diff...')
console.log('## Reviewer agent (Gemini)')
console.log('')
console.log('Reviewed commit abc1234.')
console.log('')
console.log('Verdict: approve as-is')
