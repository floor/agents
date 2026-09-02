import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAntigravityReviewer,
  AntigravityProcessError,
  AntigravityTimeoutError,
  MalformedReviewError,
  PolicyError,
  WorktreeMismatchError,
  WorktreeModifiedError,
} from '@floor-agents/antigravity-cli'

// `Bun.file(dir).exists()` is for regular files and returns `false` for an existing
// directory — using it to check whether a worktree directory was cleaned up would
// make the assertion pass even if cleanup never ran. Use this instead.
function directoryExists(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

const FIXTURES = join(import.meta.dir, 'fixtures')
const OK = join(FIXTURES, 'ok.ts')
const ROUND = join(FIXTURES, 'round.ts')
const NO_HEADER = join(FIXTURES, 'no-header.ts')
const SLEEP = join(FIXTURES, 'sleep.ts')
const FAIL = join(FIXTURES, 'fail.ts')
const RECORD = join(FIXTURES, 'record.ts')
const DIRTY = join(FIXTURES, 'dirty.ts')
const DIRTY_IGNORED = join(FIXTURES, 'dirty-ignored.ts')

const baseInput = {
  repo: 'floor/agents',
  prNumber: '14', // core's ReviewInput.prNumber is a string
  headSha: 'deadbeef', // placeholder — every test overrides this with the real `headSha` below
  prompt: 'review this please',
}

let originPath: string
let clonePath: string
let realClonePath: string
let headSha: string
let settingsDir: string
let validSettingsPath: string

async function writeSettings(deny: unknown): Promise<string> {
  const path = join(settingsDir, `settings-${crypto.randomUUID()}.json`)
  await writeFile(path, JSON.stringify({ permissions: { deny } }))
  return path
}

beforeAll(async () => {
  originPath = await mkdtemp(join(tmpdir(), 'agy-cli-test-origin-'))
  await Bun.$`git -C ${originPath} init -q --bare -b main`.quiet()

  clonePath = await mkdtemp(join(tmpdir(), 'agy-cli-test-clone-'))
  await Bun.$`git clone -q ${originPath} ${clonePath}`.quiet()
  await Bun.$`git -C ${clonePath} config user.email test@example.com`.quiet()
  await Bun.$`git -C ${clonePath} config user.name test`.quiet()
  await Bun.write(join(clonePath, 'file.txt'), 'hello\n')
  // A .gitignore'd path, used to prove assertWorktreeUnchanged catches a
  // write there too — plain `git status --porcelain` (without `--ignored`)
  // would NOT show a write to this path at all.
  await Bun.write(join(clonePath, '.gitignore'), 'ignored.txt\n')
  await Bun.$`git -C ${clonePath} add -A`.quiet()
  await Bun.$`git -C ${clonePath} commit -q -m init`.quiet()
  await Bun.$`git -C ${clonePath} push -q origin main`.quiet()
  const sha = await Bun.$`git -C ${clonePath} rev-parse HEAD`.quiet().text()
  headSha = sha.trim()
  realClonePath = await realpath(clonePath)

  settingsDir = await mkdtemp(join(tmpdir(), 'agy-cli-test-settings-'))
  validSettingsPath = await writeSettings(['write_file(*)', 'command(*)'])
})

afterAll(async () => {
  await rm(clonePath, { recursive: true, force: true }).catch(() => {})
  await rm(originPath, { recursive: true, force: true }).catch(() => {})
  await rm(settingsDir, { recursive: true, force: true }).catch(() => {})
})

// ── vendor / basic end-to-end ───────────────────────────────────────────

test('vendor is "gemini"', () => {
  const reviewer = createAntigravityReviewer({ binary: OK, settingsPath: validSettingsPath })
  expect(reviewer.vendor).toBe('gemini')
})

test('runs in the given worktreePath and returns the extracted review', async () => {
  const reviewer = createAntigravityReviewer({ binary: OK, settingsPath: validSettingsPath })
  const result = await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

  expect(result.text).toContain('## Reviewer agent (Gemini)')
  expect(result.text).toContain('Verdict: approve as-is')
  expect(result.text).not.toContain('Reading repository state...')
})

test('accepts the round-N header variant end to end', async () => {
  const reviewer = createAntigravityReviewer({ binary: ROUND, settingsPath: validSettingsPath })
  const result = await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

  expect(result.text).toBe('## Reviewer agent (Gemini), round 2\n\nVerdict: changes needed')
})

test('throws MalformedReviewError, and never returns text, when the header is missing', async () => {
  const reviewer = createAntigravityReviewer({ binary: NO_HEADER, settingsPath: validSettingsPath })

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
    MalformedReviewError,
  )
})

test('surfaces a non-zero exit as AntigravityProcessError with exit code and stderr', async () => {
  const reviewer = createAntigravityReviewer({ binary: FAIL, settingsPath: validSettingsPath })

  const failure = reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })
  await expect(failure).rejects.toBeInstanceOf(AntigravityProcessError)

  try {
    await failure
    expect.unreachable()
  } catch (err) {
    const e = err as AntigravityProcessError
    expect(e.exitCode).toBe(1)
    expect(e.stderr).toContain('fatal: policy denied a tool call')
  }
})

test('kills the process and throws AntigravityTimeoutError when it runs past timeoutMs', async () => {
  const reviewer = createAntigravityReviewer({ binary: SLEEP, settingsPath: validSettingsPath, timeoutMs: 100 })

  const start = performance.now()
  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
    AntigravityTimeoutError,
  )
  // The fixture sleeps 30s; if this took anywhere near that long, the kill didn't work.
  expect(performance.now() - start).toBeLessThan(5_000)
})

test('a caller-supplied worktreePath at the wrong commit throws WorktreeMismatchError before spawning', async () => {
  const markerFile = join(tmpdir(), `agy-test-spawned-${crypto.randomUUID()}.marker`)
  const prevEnv = process.env.AGY_TEST_RECORD
  process.env.AGY_TEST_RECORD = markerFile

  try {
    const reviewer = createAntigravityReviewer({ binary: RECORD, settingsPath: validSettingsPath })
    const wrongSha = '1'.repeat(40)

    await expect(
      reviewer.review({ ...baseInput, headSha: wrongSha, worktreePath: clonePath }),
    ).rejects.toBeInstanceOf(WorktreeMismatchError)

    expect(await Bun.file(markerFile).exists()).toBe(false)
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TEST_RECORD
    else process.env.AGY_TEST_RECORD = prevEnv
    await rm(markerFile, { force: true }).catch(() => {})
  }
})

// ── read-only deny-policy enforcement ───────────────────────────────────

test('refuses to run when the settings file does not exist', async () => {
  const reviewer = createAntigravityReviewer({
    binary: OK,
    settingsPath: join(settingsDir, 'does-not-exist.json'),
  })

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
    PolicyError,
  )
})

test('refuses to run when the settings file is not valid JSON', async () => {
  const path = join(settingsDir, `bad-json-${crypto.randomUUID()}.json`)
  await writeFile(path, '{ this is not json')
  const reviewer = createAntigravityReviewer({ binary: OK, settingsPath: path })

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
    PolicyError,
  )
})

test('refuses to run when permissions.deny is missing entirely', async () => {
  const path = join(settingsDir, `no-permissions-${crypto.randomUUID()}.json`)
  await writeFile(path, '{}')
  const reviewer = createAntigravityReviewer({ binary: OK, settingsPath: path })

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
    PolicyError,
  )
})

test('refuses to run when only "write_file(*)" is denied (missing "command(*)")', async () => {
  const path = await writeSettings(['write_file(*)'])
  const reviewer = createAntigravityReviewer({ binary: OK, settingsPath: path })

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
    PolicyError,
  )
})

test('refuses to run when only "command(*)" is denied (missing "write_file(*)")', async () => {
  const path = await writeSettings(['command(*)'])
  const reviewer = createAntigravityReviewer({ binary: OK, settingsPath: path })

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
    PolicyError,
  )
})

test('refuses to run when deny is present but empty', async () => {
  const path = await writeSettings([])
  const reviewer = createAntigravityReviewer({ binary: OK, settingsPath: path })

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
    PolicyError,
  )
})

test('runs when both "write_file(*)" and "command(*)" are denied, in either order', async () => {
  const path = await writeSettings(['command(*)', 'write_file(*)'])
  const reviewer = createAntigravityReviewer({ binary: OK, settingsPath: path })

  const result = await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })
  expect(result.text).toContain('Verdict: approve as-is')
})

test('additional entries in deny alongside the required two do not break anything', async () => {
  const path = await writeSettings(['write_file(*)', 'command(*)', 'read_file(/etc/**)'])
  const reviewer = createAntigravityReviewer({ binary: OK, settingsPath: path })

  const result = await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })
  expect(result.text).toContain('Verdict: approve as-is')
})

test('the policy check runs before spawning agy at all — the process never starts when it fails', async () => {
  const markerFile = join(tmpdir(), `agy-test-spawned-${crypto.randomUUID()}.marker`)
  const prevEnv = process.env.AGY_TEST_RECORD
  process.env.AGY_TEST_RECORD = markerFile

  try {
    const reviewer = createAntigravityReviewer({
      binary: RECORD,
      settingsPath: join(settingsDir, 'still-does-not-exist.json'),
    })

    await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
      PolicyError,
    )

    expect(await Bun.file(markerFile).exists()).toBe(false)
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TEST_RECORD
    else process.env.AGY_TEST_RECORD = prevEnv
    await rm(markerFile, { force: true }).catch(() => {})
  }
})

test('the policy is re-checked on every call, not cached from construction', async () => {
  const path = await writeSettings(['write_file(*)', 'command(*)'])
  const reviewer = createAntigravityReviewer({ binary: OK, settingsPath: path })

  // Passes the first time.
  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).resolves.toBeTruthy()

  // The settings file changes to no longer satisfy the policy (simulating an
  // operator loosening it, or it being reset) — the SAME reviewer instance
  // must refuse the next call, proving the check isn't a construction-time
  // snapshot.
  await writeFile(path, JSON.stringify({ permissions: { deny: ['write_file(*)'] } }))

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
    PolicyError,
  )
})

// ── post-run worktree-modified detection ────────────────────────────────

test('detects a worktree modified during the run and throws WorktreeModifiedError instead of returning the review', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'agy-cli-test-root-'))
  const reviewer = createAntigravityReviewer({
    binary: DIRTY,
    settingsPath: validSettingsPath,
    clonePath,
    worktreeRoot,
  })

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: undefined })).rejects.toBeInstanceOf(
    WorktreeModifiedError,
  )

  await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
})

test('a write to a .gitignore\'d path is ALSO detected — plain "git status --porcelain" would miss it, so this pins that the check passes --ignored --untracked-files=all', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'agy-cli-test-root-'))
  const reviewer = createAntigravityReviewer({
    binary: DIRTY_IGNORED,
    settingsPath: validSettingsPath,
    clonePath,
    worktreeRoot,
  })

  const err = await reviewer
    .review({ ...baseInput, headSha, worktreePath: undefined })
    .catch((e) => e)

  expect(err).toBeInstanceOf(WorktreeModifiedError)
  expect((err as WorktreeModifiedError).gitStatusPorcelain).toContain('ignored.txt')

  await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
})

test('WorktreeModifiedError still results in the auto-created worktree being cleaned up', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'agy-cli-test-root-'))
  const reviewer = createAntigravityReviewer({
    binary: DIRTY,
    settingsPath: validSettingsPath,
    clonePath,
    worktreeRoot,
  })

  let caught: unknown
  try {
    await reviewer.review({ ...baseInput, headSha, worktreePath: undefined })
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(WorktreeModifiedError)
  const dir = (caught as WorktreeModifiedError).dir

  expect(directoryExists(dir)).toBe(false)
  const list = await Bun.$`git -C ${clonePath} worktree list`.quiet().text()
  expect(list.trim().split('\n')).toHaveLength(1)

  await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
})

test('a caller-supplied worktreePath left dirty by a run is still detected, and is still never removed by this package', async () => {
  // dirty.ts writes into cwd, which here is `clonePath` itself. This proves
  // detection isn't limited to the auto-created-worktree path — but note
  // this test dirties the shared `clonePath` fixture, so it cleans up after
  // itself explicitly rather than relying on afterAll.
  const reviewer = createAntigravityReviewer({ binary: DIRTY, settingsPath: validSettingsPath })

  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })).rejects.toBeInstanceOf(
    WorktreeModifiedError,
  )

  // clonePath itself must still exist and not have been torn down (a
  // caller-supplied path is never removed by this package, even on error).
  expect(await Bun.file(join(clonePath, 'file.txt')).exists()).toBe(true)

  await rm(join(clonePath, 'unexpected-write.txt'), { force: true }).catch(() => {})
})

// ── argv is fixed by design ─────────────────────────────────────────────

type RecordedRun = { readonly argv: readonly string[]; readonly cwd: string; readonly stdin: string }

async function readRecord(recordFile: string): Promise<RecordedRun> {
  return JSON.parse(await readFile(recordFile, 'utf-8')) as RecordedRun
}

async function recordArgLines(recordFile: string): Promise<string[]> {
  return [...(await readRecord(recordFile)).argv]
}

test('rejects an invalid model value before ever spawning', () => {
  expect(() => createAntigravityReviewer({ binary: OK, model: 'gemini-3; rm -rf /' })).toThrow(/model/i)
  expect(() => createAntigravityReviewer({ binary: OK, model: '' })).toThrow(/model/i)
  expect(() => createAntigravityReviewer({ binary: OK, model: 'has spaces' })).toThrow(/model/i)
  expect(() => createAntigravityReviewer({ binary: OK, model: '$(whoami)' })).toThrow(/model/i)
})

test('rejects a model value that starts with a dash, so it can never be mistaken for a flag', () => {
  expect(() => createAntigravityReviewer({ binary: OK, model: '--effort' })).toThrow(/model/i)
  expect(() => createAntigravityReviewer({ binary: OK, model: '-x' })).toThrow(/model/i)
})

test('rejects a model value over the 128-character length cap', () => {
  const tooLong = 'a'.repeat(129)
  const atLimit = 'a'.repeat(128)

  expect(() => createAntigravityReviewer({ binary: OK, model: tooLong })).toThrow(/model/i)
  expect(() => createAntigravityReviewer({ binary: OK, model: atLimit })).not.toThrow()
})

test('rejects a non-string model value outright, including an object with a malicious toString', () => {
  const trickyObject = { toString: () => 'gemini-3.1-pro-high', valueOf: () => 'gemini-3.1-pro-high' }

  expect(() => createAntigravityReviewer({ binary: OK, model: trickyObject as unknown as string })).toThrow(/model/i)
  expect(() => createAntigravityReviewer({ binary: OK, model: 42 as unknown as string })).toThrow(/model/i)
  expect(() => createAntigravityReviewer({ binary: OK, model: null as unknown as string })).toThrow(/model/i)
})

test('rejects an invalid effort value', () => {
  expect(() => createAntigravityReviewer({ binary: OK, effort: 'extreme' as never })).toThrow(/effort/i)
  expect(() => createAntigravityReviewer({ binary: OK, effort: '' as never })).toThrow(/effort/i)
  expect(() => createAntigravityReviewer({ binary: OK, effort: 'HIGH' as never })).toThrow(/effort/i)
})

test('rejects binary: null outright, rather than silently falling back to the default', () => {
  expect(() => createAntigravityReviewer({ binary: null as unknown as string })).toThrow(/binary/i)
})

test('review() rejects a non-string ReviewInput.prompt outright, including an object with a malicious toString, before ever spawning', async () => {
  const trickyObject = { toString: () => 'PONG', valueOf: () => 'PONG' }
  const markerFile = join(tmpdir(), `agy-test-spawned-${crypto.randomUUID()}.marker`)
  const prevEnv = process.env.AGY_TEST_RECORD
  process.env.AGY_TEST_RECORD = markerFile

  try {
    const reviewer = createAntigravityReviewer({ binary: RECORD, settingsPath: validSettingsPath })

    await expect(
      reviewer.review({ ...baseInput, prompt: trickyObject as unknown as string, headSha, worktreePath: clonePath }),
    ).rejects.toThrow(/prompt/i)

    // Rejected before the worktree was even resolved / agy was spawned —
    // the RECORD fixture would have written this marker had it run.
    expect(await Bun.file(markerFile).exists()).toBe(false)
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TEST_RECORD
    else process.env.AGY_TEST_RECORD = prevEnv
    await rm(markerFile, { force: true }).catch(() => {})
  }
})

test('emits exactly [binary, "-p", header+prompt, "--output-format", "text", "--print-timeout", "14m", "--model", <default model>] with the default config', async () => {
  const recordFile = join(tmpdir(), `agy-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.AGY_TEST_RECORD
  process.env.AGY_TEST_RECORD = recordFile

  try {
    const reviewer = createAntigravityReviewer({ binary: RECORD, settingsPath: validSettingsPath })
    await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

    const argLines = await recordArgLines(recordFile)
    expect(argLines).toEqual([
      '-p',
      expect.stringContaining(baseInput.prompt) as unknown as string,
      '--output-format',
      'text',
      '--print-timeout',
      '14m',
      '--model',
      'gemini-3.1-pro-high',
    ])
    // Never emitted under any configuration (see README.md).
    expect(argLines).not.toContain('--dangerously-skip-permissions')
    expect(argLines).not.toContain('--mode')
    expect(argLines).not.toContain('--add-dir')
    expect(argLines).not.toContain('--continue')
    expect(argLines).not.toContain('--conversation')
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TEST_RECORD
    else process.env.AGY_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('emits [..., "--model", <model>, "--effort", <effort>] last, in that order, when both are set', async () => {
  const recordFile = join(tmpdir(), `agy-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.AGY_TEST_RECORD
  process.env.AGY_TEST_RECORD = recordFile

  try {
    const reviewer = createAntigravityReviewer({
      binary: RECORD,
      settingsPath: validSettingsPath,
      model: 'gemini-3.8-flash-high',
      effort: 'high',
    })
    await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

    const argLines = await recordArgLines(recordFile)
    expect(argLines.slice(-4)).toEqual(['--model', 'gemini-3.8-flash-high', '--effort', 'high'])
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TEST_RECORD
    else process.env.AGY_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('the prompt always arrives as a single argv element, header-prefixed so its first character is never "-"', async () => {
  const recordFile = join(tmpdir(), `agy-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.AGY_TEST_RECORD
  process.env.AGY_TEST_RECORD = recordFile
  const dashPrompt = '--dangerously-skip-permissions --mode danger-full-access -c anything=danger'

  try {
    const reviewer = createAntigravityReviewer({ binary: RECORD, settingsPath: validSettingsPath })
    await reviewer.review({ ...baseInput, prompt: dashPrompt, headSha, worktreePath: clonePath })

    const argLines = await recordArgLines(recordFile)

    const promptArg = argLines[1]!
    expect(promptArg.startsWith('-')).toBe(false)
    expect(promptArg).toContain(dashPrompt)
    expect(promptArg).not.toBe(dashPrompt) // it's prefixed, not passed verbatim
    expect(promptArg.endsWith(dashPrompt)).toBe(true)
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TEST_RECORD
    else process.env.AGY_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('the prompt is passed as a single argv element with metacharacters inert, and closes stdin', async () => {
  const recordFile = join(tmpdir(), `agy-test-record-${crypto.randomUUID()}.txt`)
  const dangerousPrompt = 'review `rm -rf /` and "quotes" and $(whoami) literally'
  const prevEnv = process.env.AGY_TEST_RECORD
  process.env.AGY_TEST_RECORD = recordFile

  try {
    const reviewer = createAntigravityReviewer({ binary: RECORD, settingsPath: validSettingsPath })

    await reviewer.review({ ...baseInput, prompt: dangerousPrompt, headSha, worktreePath: clonePath })

    const record = await readRecord(recordFile)

    // Exact position, not just "some argv element contains it" — proves
    // the whole dangerous string arrived as ONE argv entry, verbatim
    // (metacharacters inert, no shell involved), at the specific position
    // this adapter's fixed argv shape puts the prompt, with nothing else
    // appended after it.
    expect(record.argv[0]).toBe('-p')
    expect(record.argv[1]!.endsWith(dangerousPrompt)).toBe(true)
    expect(record.argv[2]).toBe('--output-format')
    expect(record.cwd).toBe(realClonePath)
    expect(record.stdin).toBe('closed-eof')
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TEST_RECORD
    else process.env.AGY_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('Bun.spawn receives cwd equal to the given worktreePath', async () => {
  const recordFile = join(tmpdir(), `agy-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.AGY_TEST_RECORD
  process.env.AGY_TEST_RECORD = recordFile

  try {
    const reviewer = createAntigravityReviewer({ binary: RECORD, settingsPath: validSettingsPath })
    await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

    const record = await readRecord(recordFile)
    expect(record.cwd).toBe(realClonePath)
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TEST_RECORD
    else process.env.AGY_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

// ── --print-timeout derivation ──────────────────────────────────────────

test('derives --print-timeout as (timeoutMs - 1 minute margin), rounded down to whole minutes', async () => {
  const cases: [number, string][] = [
    [15 * 60_000, '14m'],
    [10 * 60_000, '9m'],
    [5 * 60_000, '4m'],
    [3 * 60_000, '2m'],
  ]

  for (const [timeoutMs, expected] of cases) {
    const recordFile = join(tmpdir(), `agy-test-record-${crypto.randomUUID()}.txt`)
    process.env.AGY_TEST_RECORD = recordFile
    try {
      const reviewer = createAntigravityReviewer({ binary: RECORD, settingsPath: validSettingsPath, timeoutMs })
      await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

      const argLines = await recordArgLines(recordFile)
      const idx = argLines.indexOf('--print-timeout')
      expect(argLines[idx + 1]).toBe(expected)
    } finally {
      delete process.env.AGY_TEST_RECORD
      await rm(recordFile, { force: true }).catch(() => {})
    }
  }
}, 20_000)

test('below a 2-minute budget, --print-timeout uses the whole budget in seconds instead of a minute margin', async () => {
  const recordFile = join(tmpdir(), `agy-test-record-${crypto.randomUUID()}.txt`)
  process.env.AGY_TEST_RECORD = recordFile
  try {
    const reviewer = createAntigravityReviewer({ binary: RECORD, settingsPath: validSettingsPath, timeoutMs: 30_000 })
    await reviewer.review({ ...baseInput, headSha, worktreePath: clonePath })

    const argLines = await recordArgLines(recordFile)
    const idx = argLines.indexOf('--print-timeout')
    expect(argLines[idx + 1]).toBe('30s')
  } finally {
    delete process.env.AGY_TEST_RECORD
    await rm(recordFile, { force: true }).catch(() => {})
  }
})

// ── worktree lifecycle (auto-created worktree) ──────────────────────────

test('creates a detached worktree from clonePath at headSha, runs there, and removes it after success', async () => {
  const recordFile = join(tmpdir(), `agy-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.AGY_TEST_RECORD
  process.env.AGY_TEST_RECORD = recordFile

  try {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'agy-cli-test-root-'))
    const realWorktreeRoot = await realpath(worktreeRoot)
    const reviewer = createAntigravityReviewer({
      binary: RECORD,
      settingsPath: validSettingsPath,
      clonePath,
      worktreeRoot,
    })

    await reviewer.review({ ...baseInput, headSha, worktreePath: undefined })

    const record = await readRecord(recordFile)
    const usedCwd = record.cwd

    expect(usedCwd).not.toBe(await realpath(clonePath))
    expect(usedCwd.startsWith(realWorktreeRoot)).toBe(true)
    expect(usedCwd).toContain('antigravityreviewer-review-')

    expect(directoryExists(usedCwd)).toBe(false)

    const list = await Bun.$`git -C ${clonePath} worktree list`.quiet().text()
    expect(list).not.toContain(usedCwd)

    await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TEST_RECORD
    else process.env.AGY_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('removes the worktree directory (not just its git registration) even when the run fails', async () => {
  const recordFile = join(tmpdir(), `agy-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.AGY_TEST_RECORD
  process.env.AGY_TEST_RECORD = recordFile

  try {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'agy-cli-test-root-'))
    const reviewer = createAntigravityReviewer({ binary: FAIL, settingsPath: validSettingsPath, clonePath, worktreeRoot })

    await expect(reviewer.review({ ...baseInput, headSha, worktreePath: undefined })).rejects.toBeInstanceOf(
      AntigravityProcessError,
    )

    const usedCwd = (await readFile(recordFile, 'utf-8')).slice('CWD:'.length)

    // Only the main worktree (clonePath itself) should remain registered...
    const list = await Bun.$`git -C ${clonePath} worktree list`.quiet().text()
    expect(list.trim().split('\n')).toHaveLength(1)
    // ...and the directory itself must be gone too, not just deregistered.
    expect(directoryExists(usedCwd)).toBe(false)

    await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TEST_RECORD
    else process.env.AGY_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)

test('removes the worktree directory even when the run times out against a SIGTERM-ignoring process', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'agy-cli-test-root-'))
  const reviewer = createAntigravityReviewer({
    binary: SLEEP,
    settingsPath: validSettingsPath,
    clonePath,
    worktreeRoot,
    timeoutMs: 100,
  })

  const start = performance.now()
  await expect(reviewer.review({ ...baseInput, headSha, worktreePath: undefined })).rejects.toBeInstanceOf(
    AntigravityTimeoutError,
  )
  expect(performance.now() - start).toBeLessThan(5_000)

  const list = await Bun.$`git -C ${clonePath} worktree list`.quiet().text()
  expect(list.trim().split('\n')).toHaveLength(1)

  await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
}, 10_000)

test('throws a clear error when neither worktreePath nor clonePath is given', async () => {
  const reviewer = createAntigravityReviewer({ binary: OK, settingsPath: validSettingsPath })

  await expect(reviewer.review({ ...baseInput, worktreePath: undefined })).rejects.toThrow(
    /worktreePath.*clonePath|clonePath.*worktreePath/i,
  )
})

test('never runs directly in the clone itself', async () => {
  const recordFile = join(tmpdir(), `agy-test-record-${crypto.randomUUID()}.txt`)
  const prevEnv = process.env.AGY_TEST_RECORD
  process.env.AGY_TEST_RECORD = recordFile

  try {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'agy-cli-test-root-'))
    const reviewer = createAntigravityReviewer({
      binary: RECORD,
      settingsPath: validSettingsPath,
      clonePath,
      worktreeRoot,
    })

    await reviewer.review({ ...baseInput, headSha, worktreePath: undefined })

    const record = await readRecord(recordFile)
    const usedCwd = record.cwd

    expect(usedCwd).not.toBe(await realpath(clonePath))

    await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TEST_RECORD
    else process.env.AGY_TEST_RECORD = prevEnv
    await rm(recordFile, { force: true }).catch(() => {})
  }
}, 10_000)
