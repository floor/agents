#!/usr/bin/env bun
// Fixture for test/orchestrator/gate/codex-cli-integration.test.ts's
// verbatim-posting proof: a canned Codex run whose review body carries
// whitespace beyond a plain single-line-per-paragraph shape — a two-space
// indent on the line right after the header, and two extra blank lines
// after the verdict line — so the test's byte-for-byte comparison actually
// exercises whitespace fidelity through the whole path (extractReview(),
// Reviewer.review(), loop.ts, addPRComment) instead of comparing two
// already-minimal strings that would match regardless of a formatting bug.
//
// Note: the two trailing blank lines here are still stripped by
// extractReview()'s own `.replace(/\s+$/, '')` (see
// packages/codex-cli/src/extract.ts) — by design, its output is always
// boundary-whitespace-free, so a downstream `.trim()` on that result is
// provably a no-op no matter what a fixture puts after the verdict line.
// The two-space indent on the line below the header is genuinely internal
// (not at either boundary of the extracted string), so it survives both
// extractReview() and any hypothetical `.trim()`. This fixture therefore
// proves mid-string fidelity only: a reformat or re-indent of
// `result.text` before posting would fail the test, a boundary-only
// `.trim()` would not. The trim regression is pinned separately by the
// loop-level test in test/orchestrator/gate/loop.test.ts, whose
// hand-built Reviewer bypasses extractReview().
console.log('Reading repository state...')
console.log('Cross-referencing changed files against the diff...')
console.log('## Reviewer agent (Codex)')
console.log('  Reviewed commit abc1234.')
console.log('')
console.log('Verdict: approve as-is')
console.log('')
console.log('')
