#!/usr/bin/env bun
// Fixture: writes a stray file into its own cwd (the review worktree) before
// emitting an otherwise-canned successful review — used to prove the adapter's
// post-run `git status --porcelain` check catches a worktree the deny policy
// should have kept clean, and throws WorktreeModifiedError instead of trusting
// (or returning) the review. A real `agy` should never do this (that's exactly
// what the deny policy is for), but this simulates the policy having failed.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

writeFileSync(join(process.cwd(), 'unexpected-write.txt'), 'a write the deny policy should have blocked\n')

console.log('Reading repository state...')
console.log('## Reviewer agent (Gemini)')
console.log('Verdict: approve as-is')
