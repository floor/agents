import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCodexReviewer,
  CodexProcessError,
  CodexTimeoutError,
  MalformedReviewError,
  WorktreeMismatchError,
} from '@floor-agents/codex-cli'

// `Bun.file(dir).exists()` is for regular files and returns `false` for an existing
// directory — using it to check whether a worktree directory was cleaned up would
// make the assertion pass even if cleanup never ran. Use this instead.
function directoryExists(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

// A child process's `process.cwd()` reports the OS-resolved path (e.g. `/private/tmp`
// on macOS, where `/tmp` is a symlink), so paths built here must be resolved the same
// way (see `realClonePath`/`realpath()` calls below) before comparing against what a
// fixture recorded.

const FIXTURES = join(import.meta.dir, 'fixtures')
const OK = join(FIXTURES, 'ok.ts')
const ROUND = join(FIXTURES, 'round.ts')
const NO_HEADER = join(FIXTURES, 'no-header.ts')
const SLEEP = join(FIXTURES, 'sleep.ts')
const FAIL = join(FIXTURES, 'fail.ts')
const RECORD = join(FIXTURES, 'record.ts')

const baseInput = {
  repo: 'floor/agents',
  prNumber: '14', // core's ReviewInput.prNumber is a string
  headSha: 'deadbeef', // placeholder — every test overrides this with the real `headSha` below
  prompt: 'review this please',
}

// A real local git repo + commit, used two ways below: (a) as `clonePath`, for tests
// exercising the auto-created-worktree path, and (b) directly as a caller-supplied
// `worktreePath`, since round 5 requires `resolveWorktree` to verify ANY worktreePath
// (caller-supplied or created by this package) actually has `headSha` checked out
// before spawning — a bogus placeholder path no longer works for those tests either.
let originPath: string
let clonePath: string
let realClonePath: string
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
  realClonePath = await realpath(clonePath)
})

afterAll(async () => {
  await rm(clonePath, { recursive: true, force: true }).catch(() => {})
  await rm(originPath, { recursive: true, force: true }).catch(() => {})
})

// ── Given an explicit worktreePath, no git worktree is created or touched ──────────
// (clonePath itself, at headSha, stands in for "a caller-supplied worktree" in these
// tests — it's a real checkout at a known commit, which is what the verification
// added in round 5 requires.)

test('runs in the given worktreePath and returns the extracted review', async () => {
  const reviewer = createCodexReviewer({ binary: OK })
  const result = await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

  expect(result.text).toContain('## Reviewer agent (Codex)')
  expect(result.text).toContain('Verdict: approve as-is')
  expect(result.text).not.toContain('Reading repository state...')
})

test('accepts the round-N header variant end to end', async () => {
  const reviewer = createCodexReviewer({ binary: ROUND })
  const result = await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

  expect(result.text).toBe('## Reviewer agent (Codex), round 2\n\nVerdict: changes needed')
})

test('vendor is "codex"', () => {
  const reviewer = createCodexReviewer({ binary: OK })
  expect(reviewer.vendor).toBe('codex')
})

test('a caller-supplied worktreePath at the wrong commit throws WorktreeMismatchError before spawning, and codex never runs', async () => {
  // A binary that would prove itself if spawned: it writes a marker file the moment
  // it starts, so a mismatch check that (bug!) spawned anyway would be caught here.
  const markerFile = join(tmpdir(), `codex-test-spawned-${crypto.randomUUID()}.marker`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = markerFile

  try {
    const reviewer = createCodexReviewer({ binary: RECORD })
    const wrongSha = '1'.repeat(40) // clonePath's real HEAD is `headSha`, not this

    await expect(
      reviewer.review({ ...baseInput, headSha: wrongSha, worktreePath: clonePath }),
    ).rejects.toBeInstanceOf(WorktreeMismatchError)

    expect(await Bun.file(markerFile).exists()).toBe(false)
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(markerFile, { force: true }).catch(() => {})
  }
})

test('never removes a caller-supplied worktreePath, even on a mismatch', async () => {
  const reviewer = createCodexReviewer({ binary: OK })
  const wrongSha = '2'.repeat(40)

  await expect(
    reviewer.review({ ...baseInput, headSha: wrongSha, worktreePath: clonePath }),
  ).rejects.toBeInstanceOf(WorktreeMismatchError)

  // clonePath is the shared fixture other tests still depend on — it must survive.
  // (`Bun.file(dir).exists()` is for regular files; check a file inside it instead,
  // and that it's still a registered, intact git working directory.)
  expect(await Bun.file(join(clonePath, 'file.txt')).exists()).toBe(true)
  const list = await Bun.$`git -C ${clonePath} worktree list`.quiet().text()
  expect(list.trim().split('\n')).toHaveLength(1)
})

// ── round 6: a config/input value can't shift under us between validation and use ──

function makeShiftyPath(firstValue: string, laterValue: string) {
  let calls = 0
  return {
    object: {
      toString: () => {
        calls++
        return calls === 1 ? firstValue : laterValue
      },
    },
    getCallCount: () => calls,
  }
}

test('rejects a worktreePath that is an object (even one with a toString) outright, before it ever reaches git rev-parse', async () => {
  const { object: shiftyPath, getCallCount } = makeShiftyPath(clonePath, '/definitely/does/not/exist')

  const reviewer = createCodexReviewer({ binary: OK })

  await expect(
    reviewer.review({ ...baseInput, headSha, worktreePath: shiftyPath as unknown as string }),
  ).rejects.toThrow(/worktreePath/i)

  // The type check must reject the object outright — never even coerce it once
  // (which a `` `${worktreePath}` `` or similar would do), let alone read it twice to
  // reach a real path by the time `git rev-parse` runs.
  expect(getCallCount()).toBe(0)
})

test('rejects a clonePath that is an object (even one with a toString) at construction, before any git call', () => {
  const { object: shiftyPath, getCallCount } = makeShiftyPath(clonePath, '/definitely/does/not/exist')

  expect(() => createCodexReviewer({ binary: OK, clonePath: shiftyPath as unknown as string })).toThrow(
    /clonePath/i,
  )
  expect(getCallCount()).toBe(0)
})

test('rejects a non-string binary or worktreeRoot at construction, same as clonePath/model/profile', () => {
  const { object: shiftyPath } = makeShiftyPath('a', 'b')

  expect(() => createCodexReviewer({ binary: shiftyPath as unknown as string })).toThrow(/binary/i)
  expect(() => createCodexReviewer({ binary: OK, worktreeRoot: shiftyPath as unknown as string })).toThrow(
    /worktreeRoot/i,
  )
  expect(() => createCodexReviewer({ binary: OK, worktreeRoot: '' })).toThrow(/worktreeRoot/i)
})

test('rejects binary: null outright, rather than letting ?? DEFAULT_BINARY silently swallow it', () => {
  // A plain `config.binary ?? DEFAULT_BINARY` would treat an explicit `null` the same
  // as `undefined` and silently fall back to the default binary — this must instead
  // be rejected the same as any other non-string value.
  expect(() => createCodexReviewer({ binary: null as unknown as string })).toThrow(/binary/i)
})

test('Bun.spawn receives cwd equal to the given worktreePath in the caller-supplied case, not only the auto-created case', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const reviewer = createCodexReviewer({ binary: RECORD })
    await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

    const record = await readFile(recordFile, 'utf-8')
    const cwdLine = record.split('\n').find((l) => l.startsWith('CWD:'))!
    expect(cwdLine).toBe(`CWD:${realClonePath}`)
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

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

test('rejects a model/profile value that starts with a dash, so it can never be mistaken for a flag by codex\'s own argv parser', () => {
  expect(() => createCodexReviewer({ binary: OK, model: '--sandbox' })).toThrow(/model/i)
  expect(() => createCodexReviewer({ binary: OK, model: '-x' })).toThrow(/model/i)
  expect(() => createCodexReviewer({ binary: OK, profile: '--sandbox' })).toThrow(/profile/i)
  expect(() => createCodexReviewer({ binary: OK, profile: '-x' })).toThrow(/profile/i)
})

test('rejects a model value over the 128-character length cap', () => {
  const tooLong = 'a'.repeat(129)
  const atLimit = 'a'.repeat(128)

  expect(() => createCodexReviewer({ binary: OK, model: tooLong })).toThrow(/model/i)
  expect(() => createCodexReviewer({ binary: OK, model: atLimit })).not.toThrow()
})

test('rejects a profile value over the 128-character length cap', () => {
  const tooLong = 'a'.repeat(129)
  const atLimit = 'a'.repeat(128)

  expect(() => createCodexReviewer({ binary: OK, profile: tooLong })).toThrow(/profile/i)
  expect(() => createCodexReviewer({ binary: OK, profile: atLimit })).not.toThrow()
})

test('rejects a non-string model/profile value outright, including an object with a malicious toString', () => {
  const trickyObject = {
    toString: () => '--sandbox',
    valueOf: () => '--sandbox',
  }

  expect(() => createCodexReviewer({ binary: OK, model: trickyObject as unknown as string })).toThrow(/model/i)
  expect(() => createCodexReviewer({ binary: OK, profile: trickyObject as unknown as string })).toThrow(
    /profile/i,
  )
  expect(() => createCodexReviewer({ binary: OK, model: 42 as unknown as string })).toThrow(/model/i)
  expect(() => createCodexReviewer({ binary: OK, model: null as unknown as string })).toThrow(/model/i)
})

test('emits exactly [binary, "exec", "--sandbox", "read-only", "--", prompt] when neither model nor profile is set', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const reviewer = createCodexReviewer({ binary: RECORD })
    await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

    expect(await recordArgLines(recordFile)).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--',
      baseInput.prompt,
    ])
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('emits exactly [..., "--model", <model>, "--", prompt] when only model is set', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const reviewer = createCodexReviewer({ binary: RECORD, model: 'gpt-5.1-codex' })
    await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

    expect(await recordArgLines(recordFile)).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-5.1-codex',
      '--',
      baseInput.prompt,
    ])
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('emits exactly [..., "--model", <model>, "--profile", <profile>, "--", prompt] when both are set', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile

  try {
    const reviewer = createCodexReviewer({ binary: RECORD, model: 'gpt-5.1-codex', profile: 'ci-reviewer_v1' })
    await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

    expect(await recordArgLines(recordFile)).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-5.1-codex',
      '--profile',
      'ci-reviewer_v1',
      '--',
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
    await reviewer.review({ ...baseInput, prompt: dashPrompt, headSha, worktreePath: clonePath })

    const argLines = await recordArgLines(recordFile)
    expect(argLines).toEqual(['exec', '--sandbox', 'read-only', '--model', 'gpt-5.1-codex', '--', dashPrompt])
    // The prompt arrives as ONE argv entry, last, verbatim, immediately after the `--`
    // terminator — not split into separate flags, and not capable of injecting an
    // earlier argv element or being parsed as a flag itself.
    expect(argLines).toHaveLength(7)
    expect(argLines.at(-2)).toBe('--')
    expect(argLines.at(-1)).toBe(dashPrompt)
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('the prompt is treated as positional text even when it starts with "--cd=/" (a real codex flag), because "--" precedes it', async () => {
  const recordFile = join(tmpdir(), `codex-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.CODEX_TEST_RECORD
  process.env.CODEX_TEST_RECORD = recordFile
  const cdPrompt = '--cd=/ do something dangerous-sounding'

  try {
    const reviewer = createCodexReviewer({ binary: RECORD })
    await reviewer.review({ ...baseInput, prompt: cdPrompt, headSha, worktreePath: clonePath })

    const argLines = await recordArgLines(recordFile)
    expect(argLines).toEqual(['exec', '--sandbox', 'read-only', '--', cdPrompt])

    const dashDashIndex = argLines.indexOf('--')
    expect(dashDashIndex).toBeGreaterThanOrEqual(0)
    // The `--` terminator must be the element immediately before the prompt, so
    // nothing between them could be mistaken for another flag.
    expect(argLines[dashDashIndex + 1]).toBe(cdPrompt)
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('throws MalformedReviewError, and never returns text, when the header is missing', async () => {
  const reviewer = createCodexReviewer({ binary: NO_HEADER })

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
    MalformedReviewError,
  )
})

test('surfaces a non-zero exit as CodexProcessError with exit code and stderr', async () => {
  const reviewer = createCodexReviewer({ binary: FAIL })

  const failure = reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })
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
  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
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

    await reviewer.review({ ...baseInput, prompt: dangerousPrompt, headSha, worktreePath: clonePath })

    const record = await readFile(recordFile, 'utf-8')
    const lines = record.split('\n')

    expect(lines).toContain('ARG:exec')
    expect(lines).toContain('ARG:--sandbox')
    expect(lines).toContain('ARG:read-only')
    // The whole dangerous prompt arrives as ONE argv entry, verbatim — proof there was
    // no shell involved to interpret `` ` `` / `$()` / quotes inside it.
    expect(lines).toContain(`ARG:${dangerousPrompt}`)
    expect(lines.some((l) => l.startsWith('ARG:') && l.includes('rm -rf'))).toBe(true)

    expect(lines).toContain(`CWD:${realClonePath}`)
    expect(lines.find((l) => l.startsWith('STDIN:'))).toBe('STDIN:closed-eof')
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_TEST_RECORD
    else process.env.CODEX_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

// ── worktree lifecycle (auto-created worktree, review() called without a worktreePath) ─

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
    expect(directoryExists(usedCwd)).toBe(false)

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
    expect(directoryExists(usedCwd)).toBe(false)

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
    expect(directoryExists(usedCwd)).toBe(false)

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
