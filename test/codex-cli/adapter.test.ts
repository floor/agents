import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCodexReviewer,
  CodexProcessError,
  CodexTimeoutError,
  MalformedReviewError,
} from '@floor-agents/codex-cli'

// A child process's `process.cwd()` reports the OS-resolved path (e.g. `/private/tmp`
// on macOS, where `/tmp` is a symlink), so paths built here must be resolved the same
// way before comparing against what a fixture recorded.
const REAL_TMP = await realpath(tmpdir())

const FIXTURES = join(import.meta.dir, 'fixtures')
const OK = join(FIXTURES, 'ok.ts')
const ROUND = join(FIXTURES, 'round.ts')
const NO_HEADER = join(FIXTURES, 'no-header.ts')
const SLEEP = join(FIXTURES, 'sleep.ts')
const FAIL = join(FIXTURES, 'fail.ts')
const RECORD = join(FIXTURES, 'record.ts')

const baseInput = {
  repo: 'floor/agents',
  prNumber: 1,
  headSha: 'deadbeef',
  prompt: 'review this please',
}

// ── Given an explicit worktreePath, no git worktree is created or touched ──────────

test('runs in the given worktreePath and returns the extracted review', async () => {
  const reviewer = createCodexReviewer({ binary: OK })
  const result = await reviewer.review({ ...baseInput, worktreePath: REAL_TMP })

  expect(result.text).toContain('## Reviewer agent (Codex)')
  expect(result.text).toContain('Verdict: approve as-is')
  expect(result.text).not.toContain('Reading repository state...')
})

test('accepts the round-N header variant end to end', async () => {
  const reviewer = createCodexReviewer({ binary: ROUND })
  const result = await reviewer.review({ ...baseInput, worktreePath: REAL_TMP })

  expect(result.text).toBe('## Reviewer agent (Codex), round 2\n\nVerdict: changes needed')
})

test('vendor is "codex"', () => {
  const reviewer = createCodexReviewer({ binary: OK })
  expect(reviewer.vendor).toBe('codex')
})

// ── argv is fixed by design: no extraArgs, only two typed & validated options ──────
//
// After three rounds of a denylist chasing new bypass spellings (a second --sandbox,
// a short alias, a compact form, -c/--config, --add-dir, --cd/-C...), there is no
// caller-extensible argv any more. `model`/`profile` are the only configurable
// pieces, each validated against a strict charset and each rendered as exactly its
// own flag pair — there is no path from a config value to an arbitrary argv element.

async function recordArgLines(recordFile: string): Promise<string[]> {
  const record = await readFile(recordFile, 'utf-8')
  return record
    .split('\n')
    .filter((l) => l.startsWith('ARG:'))
    .map((l) => l.slice('ARG:'.length))
}

test('rejects an invalid model value before ever spawning', () => {
  expect(() => createCodexReviewer({ binary: OK, model: 'gpt-4; rm -rf /' })).toThrow(/model/i)
  expect(() => createCodexReviewer({ binary: OK, model: '' })).toThrow(/model/i)
  expect(() => createCodexReviewer({ binary: OK, model: 'has spaces' })).toThrow(/model/i)
  expect(() => createCodexReviewer({ binary: OK, model: '$(whoami)' })).toThrow(/model/i)
})

test('rejects an invalid profile value before ever spawning', () => {
  expect(() => createCodexReviewer({ binary: OK, profile: 'ci reviewer' })).toThrow(/profile/i)
  expect(() => createCodexReviewer({ binary: OK, profile: '$(whoami)' })).toThrow(/profile/i)
  expect(() => createCodexReviewer({ binary: OK, profile: 'a/b' })).toThrow(/profile/i)
})

test('emits exactly [binary, "exec", "--sandbox", "read-only", prompt] when neither model nor profile is set', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const reviewer = createCodexReviewer({ binary: RECORD })
    await reviewer.review({ ...baseInput, worktreePath: REAL_TMP })

    expect(await recordArgLines(recordFile)).toEqual(['exec', '--sandbox', 'read-only', baseInput.prompt])
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('emits exactly [..., "--model", <model>, prompt] when only model is set', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const reviewer = createCodexReviewer({ binary: RECORD, model: 'gpt-5.1-codex' })
    await reviewer.review({ ...baseInput, worktreePath: REAL_TMP })

    expect(await recordArgLines(recordFile)).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-5.1-codex',
      baseInput.prompt,
    ])
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('emits exactly [..., "--model", <model>, "--profile", <profile>, prompt] when both are set', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const reviewer = createCodexReviewer({ binary: RECORD, model: 'gpt-5.1-codex', profile: 'ci-reviewer_v1' })
    await reviewer.review({ ...baseInput, worktreePath: REAL_TMP })

    expect(await recordArgLines(recordFile)).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-5.1-codex',
      '--profile',
      'ci-reviewer_v1',
      baseInput.prompt,
    ])
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('the prompt is always the final argv element, even when it starts with a dash and looks like flags', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile
  const dashPrompt = '--sandbox danger-full-access --add-dir / -c sandbox_mode=danger-full-access'

  try {
    const reviewer = createCodexReviewer({ binary: RECORD, model: 'gpt-5.1-codex' })
    await reviewer.review({ ...baseInput, prompt: dashPrompt, worktreePath: REAL_TMP })

    const argLines = await recordArgLines(recordFile)
    expect(argLines).toEqual(['exec', '--sandbox', 'read-only', '--model', 'gpt-5.1-codex', dashPrompt])
    // The prompt arrives as ONE argv entry, last, verbatim — not split into separate
    // flags, and not capable of injecting an earlier argv element.
    expect(argLines).toHaveLength(6)
    expect(argLines.at(-1)).toBe(dashPrompt)
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('throws MalformedReviewError, and never returns text, when the header is missing', async () => {
  const reviewer = createCodexReviewer({ binary: NO_HEADER })

  await expect(reviewer.review({ ...baseInput, worktreePath: REAL_TMP })).rejects.toBeInstanceOf(
    MalformedReviewError,
  )
})

test('surfaces a non-zero exit as CodexProcessError with exit code and stderr', async () => {
  const reviewer = createCodexReviewer({ binary: FAIL })

  const failure = reviewer.review({ ...baseInput, worktreePath: REAL_TMP })
  await expect(failure).rejects.toBeInstanceOf(CodexProcessError)

  try {
    await failure
    expect.unreachable()
  } catch (err) {
    const e = err as CodexProcessError
    expect(e.exitCode).toBe(1)
    expect(e.stderr).toContain('fatal: sandbox denied access to repository')
  }
})

test('kills the process and throws CodexTimeoutError when it runs past timeoutMs', async () => {
  const reviewer = createCodexReviewer({ binary: SLEEP, timeoutMs: 100 })

  const start = performance.now()
  await expect(reviewer.review({ ...baseInput, worktreePath: REAL_TMP })).rejects.toBeInstanceOf(
    CodexTimeoutError,
  )
  // The fixture sleeps 30s; if this took anywhere near that long, the kill didn't work.
  expect(performance.now() - start).toBeLessThan(5_000)
})

// ── argv / stdin correctness ────────────────────────────────────────────────────────

test('passes the prompt as a single argv element, with metacharacters inert, and closes stdin', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const dangerousPrompt = 'review `rm -rf /` and "quotes" and $(whoami) literally'
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const reviewer = createCodexReviewer({ binary: RECORD })

    await reviewer.review({ ...baseInput, prompt: dangerousPrompt, worktreePath: REAL_TMP })

    const record = await readFile(recordFile, 'utf-8')
    const lines = record.split('\n')

    expect(lines).toContain('ARG:exec')
    expect(lines).toContain('ARG:--sandbox')
    expect(lines).toContain('ARG:read-only')
    // The whole dangerous prompt arrives as ONE argv entry, verbatim — proof there was
    // no shell involved to interpret `` ` `` / `$()` / quotes inside it.
    expect(lines).toContain(`ARG:${dangerousPrompt}`)
    expect(lines.some((l) => l.startsWith('ARG:') && l.includes('rm -rf'))).toBe(true)

    expect(lines).toContain(`CWD:${REAL_TMP}`)
    expect(lines.find((l) => l.startsWith('STDIN:'))).toBe('STDIN:closed-eof')
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

// ── worktree lifecycle ──────────────────────────────────────────────────────────────

let originPath: string
let clonePath: string
let headSha: string

beforeAll(async () => {
  // `resolveWorktree` always does `git fetch origin <sha>`, mirroring a real clone of
  // a remote repo — so the test fixture needs a real `origin` remote, not just a bare
  // local repo with a commit in it.
  originPath = await mkdtemp(join(tmpdir(), 'codex-cli-test-origin-'))
  await Bun.$`git -C ${originPath} init -q --bare -b main`.quiet()

  clonePath = await mkdtemp(join(tmpdir(), 'codex-cli-test-clone-'))
  await Bun.$`git clone -q ${originPath} ${clonePath}`.quiet()
  await Bun.$`git -C ${clonePath} config user.email test@example.com`.quiet()
  await Bun.$`git -C ${clonePath} config user.name test`.quiet()
  await Bun.write(join(clonePath, 'file.txt'), 'hello\n')
  await Bun.$`git -C ${clonePath} add -A`.quiet()
  await Bun.$`git -C ${clonePath} commit -q -m init`.quiet()
  await Bun.$`git -C ${clonePath} push -q origin main`.quiet()
  const sha = await Bun.$`git -C ${clonePath} rev-parse HEAD`.quiet().text()
  headSha = sha.trim()
})

afterAll(async () => {
  await rm(clonePath, { recursive: true, force: true }).catch(() => {})
  await rm(originPath, { recursive: true, force: true }).catch(() => {})
})

test('creates a detached worktree from clonePath at headSha, runs there, and removes it after success', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'codex-cli-test-root-'))
    const realWorktreeRoot = await realpath(worktreeRoot)
    const reviewer = createCodexReviewer({ binary: RECORD, clonePath, worktreeRoot })

    await reviewer.review({ ...baseInput, headSha, worktreePath: undefined })

    const record = await readFile(recordFile, 'utf-8')
    const cwdLine = record.split('\n').find((l) => l.startsWith('CWD:'))!
    const usedCwd = cwdLine.slice('CWD:'.length)

    expect(usedCwd).not.toBe(await realpath(clonePath))
    expect(usedCwd.startsWith(realWorktreeRoot)).toBe(true)

    // The worktree directory must be gone after a successful review.
    const worktreeGone = await Bun.file(usedCwd).exists()
    expect(worktreeGone).toBe(false)

    const list = await Bun.$`git -C ${clonePath} worktree list`.quiet().text()
    expect(list).not.toContain(usedCwd)

    await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('removes the worktree directory (not just its git registration) even when the run fails', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'codex-cli-test-root-'))
    const reviewer = createCodexReviewer({ binary: FAIL, clonePath, worktreeRoot })

    await expect(reviewer.review({ ...baseInput, headSha, worktreePath: undefined })).rejects.toBeInstanceOf(
      CodexProcessError,
    )

    const usedCwd = (await readFile(recordFile, 'utf-8')).slice('CWD:'.length)

    // Only the main worktree (clonePath itself) should remain registered...
    const list = await Bun.$`git -C ${clonePath} worktree list`.quiet().text()
    expect(list.trim().split('\n')).toHaveLength(1)
    // ...and the directory itself must be gone too, not just deregistered.
    expect(await Bun.file(usedCwd).exists()).toBe(false)

    await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('removes the worktree directory even when the run times out against a SIGTERM-ignoring process', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'codex-cli-test-root-'))
    const reviewer = createCodexReviewer({ binary: SLEEP, clonePath, worktreeRoot, timeoutMs: 100 })

    const start = performance.now()
    await expect(reviewer.review({ ...baseInput, headSha, worktreePath: undefined })).rejects.toBeInstanceOf(
      CodexTimeoutError,
    )
    // The fixture ignores SIGTERM and sleeps 30s; only a SIGKILL keeps this fast.
    expect(performance.now() - start).toBeLessThan(5_000)

    const usedCwd = (await readFile(recordFile, 'utf-8')).slice('CWD:'.length)

    const list = await Bun.$`git -C ${clonePath} worktree list`.quiet().text()
    expect(list.trim().split('\n')).toHaveLength(1)
    expect(await Bun.file(usedCwd).exists()).toBe(false)

    await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('propagates a git-fetch failure (unknown headSha) without leaking a worktree registration', async () => {
  const reviewer = createCodexReviewer({ binary: OK, clonePath })
  const bogusSha = '0'.repeat(40)

  await expect(
    reviewer.review({ ...baseInput, headSha: bogusSha, worktreePath: undefined }),
  ).rejects.toThrow()

  // Setup failed during `git fetch` itself (this sha doesn't exist at origin), before
  // `git worktree add` or codex ever ran — confirm that failure didn't leave a
  // half-registered worktree behind either.
  const list = await Bun.$`git -C ${clonePath} worktree list`.quiet().text()
  expect(list.trim().split('\n')).toHaveLength(1)
})

test('propagates a git-worktree-add failure specifically (valid fetch, unusable target) and cleans up', async () => {
  // Force `git worktree add` itself to fail, as distinct from a `git fetch` failure:
  // point worktreeRoot at a path whose parent is a regular file, so git cannot create
  // anything under it, even though the fetch (headSha is valid here) succeeds first.
  const blockerDir = await mkdtemp(join(tmpdir(), 'codex-cli-test-blocker-'))
  const blockerFile = join(blockerDir, 'not-a-directory')
  await Bun.write(blockerFile, 'x')

  const reviewer = createCodexReviewer({ binary: OK, clonePath, worktreeRoot: blockerFile })

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: undefined })).rejects.toThrow()

  const list = await Bun.$`git -C ${clonePath} worktree list`.quiet().text()
  expect(list.trim().split('\n')).toHaveLength(1)

  await rm(blockerDir, { recursive: true, force: true }).catch(() => {})
}, 10_000)

test('throws a clear error when neither worktreePath nor clonePath is given', async () => {
  const reviewer = createCodexReviewer({ binary: OK })

  await expect(reviewer.review({ ...baseInput, worktreePath: undefined })).rejects.toThrow(
    /worktreePath.*clonePath|clonePath.*worktreePath/i,
  )
})

test('never runs directly in the clone itself', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'codex-cli-test-root-'))
    const reviewer = createCodexReviewer({ binary: RECORD, clonePath, worktreeRoot })

    await reviewer.review({ ...baseInput, headSha, worktreePath: undefined })

    const record = await readFile(recordFile, 'utf-8')
    const usedCwd = record.split('\n').find((l) => l.startsWith('CWD:'))!.slice('CWD:'.length)

    expect(usedCwd).not.toBe(await realpath(clonePath))

    await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)
