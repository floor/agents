#!/usr/bin/env bun
// Fixture: writes to a path matched by the worktree's own .gitignore (see
// adapter.test.ts's beforeAll) before emitting an otherwise-canned
// successful review — used to prove assertWorktreeUnchanged catches this
// too. Plain `git status --porcelain` (without `--ignored`) would NOT
// report a write to a gitignored path at all; this fixture pins that the
// adapter's check actually passes `--ignored --untracked-files=all`.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

writeFileSync(join(process.cwd(), 'ignored.txt'), 'a write the deny policy should have blocked\n')

console.log('Reading repository state...')
console.log('## Reviewer agent (Gemini)')
console.log('Verdict: approve as-is')
