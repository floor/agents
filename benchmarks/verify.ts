#!/usr/bin/env bun
/**
 * Benchmark verifier — proves that every task in `benchmarks/tasks/` can score an agent run.
 *
 * For each task it checks out `repo` at `baseCommit` in a temp dir, then
 *   (a) discrimination: applies only the reference PR's `testFiles` (from `referenceHead`)
 *       and runs `checks` — they must FAIL;
 *   (b) solvability: checks out `referenceHead` (the full solution) and runs `checks`
 *       — they must PASS.
 *
 *   bun benchmarks/verify.ts                 # every task
 *   bun benchmarks/verify.ts --only <id>     # one task (repeatable)
 *   bun benchmarks/verify.ts --verbose       # print the checks' output
 *
 * One clone per repository is cached under $BENCH_CACHE (default: <tmpdir>/floor-agents-benchmarks)
 * and fetched again only when a task needs a commit it does not hold. The verifier is
 * standalone: it needs git, bun and network access to GitHub, and nothing from the engine.
 */

import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export type SizeClass = 'XS' | 'S' | 'M'

export type Task = {
  id: string
  repo: string
  baseCommit: string
  referencePr: number
  referenceHead: string
  sizeClass: SizeClass
  changedSourceLines: number
  brief: string
  testFiles: string[]
  checks: string[]
  notes?: string
}

type CheckRun = {
  ok: boolean
  ms: number
  failed?: string
  loadError: boolean
  output: string
}

type TaskResult = {
  task: Task
  a?: CheckRun
  b?: CheckRun
  error?: string
}

const TASKS_DIR = join(import.meta.dir, 'tasks')
const CACHE = process.env.BENCH_CACHE ?? join(tmpdir(), 'floor-agents-benchmarks')
const CHECK_TIMEOUT_MS = 10 * 60_000
const SHA = /^[0-9a-f]{40}$/

// ── Tasks ────────────────────────────────────────────────────────

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(x => typeof x === 'string')

export const parseTask = (raw: unknown, file: string): Task => {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${file}: not a mapping`)
  const r = raw as Record<string, unknown>
  const str = (k: string): string => {
    const v = r[k]
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`${file}: '${k}' must be a non-empty string`)
    return v
  }
  const num = (k: string): number => {
    const v = r[k]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`${file}: '${k}' must be a non-negative integer`)
    return v
  }
  const list = (k: string): string[] => {
    const v = r[k]
    if (!isStringArray(v) || v.length === 0) throw new Error(`${file}: '${k}' must be a non-empty list of strings`)
    return v
  }
  const sizeClass = str('sizeClass')
  if (sizeClass !== 'XS' && sizeClass !== 'S' && sizeClass !== 'M') throw new Error(`${file}: sizeClass must be XS, S or M`)
  const task: Task = {
    id: str('id'),
    repo: str('repo'),
    baseCommit: str('baseCommit'),
    referencePr: num('referencePr'),
    referenceHead: str('referenceHead'),
    sizeClass,
    changedSourceLines: num('changedSourceLines'),
    brief: str('brief'),
    testFiles: list('testFiles'),
    checks: list('checks'),
  }
  if (typeof r.notes === 'string') task.notes = r.notes
  if (!/^[\w.-]+\/[\w.-]+$/.test(task.repo)) throw new Error(`${file}: repo must be owner/name`)
  if (!SHA.test(task.baseCommit) || !SHA.test(task.referenceHead)) throw new Error(`${file}: commits must be full SHAs`)
  if (`${task.id}.yaml` !== file) throw new Error(`${file}: id '${task.id}' does not match the file name`)
  return task
}

export const loadTasks = async (dir = TASKS_DIR): Promise<Task[]> => {
  const files = (await readdir(dir)).filter(f => f.endsWith('.yaml')).sort()
  const tasks: Task[] = []
  for (const f of files) {
    tasks.push(parseTask(Bun.YAML.parse(await Bun.file(join(dir, f)).text()), f))
  }
  return tasks
}

// ── Processes ────────────────────────────────────────────────────

type Exec = { code: number, out: string }

const exec = async (cmd: string[], cwd: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<Exec> => {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, out: out + err }
}

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await exec(['git', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}):\n${r.out.trim()}`)
  return r.out
}

const hasCommit = async (clone: string, sha: string): Promise<boolean> =>
  (await exec(['git', 'cat-file', '-e', `${sha}^{commit}`], clone)).code === 0

// ── Repositories ─────────────────────────────────────────────────

const clones = new Map<string, Promise<string>>()

const cachedClone = (repo: string): Promise<string> => {
  const known = clones.get(repo)
  if (known) return known
  const p = (async () => {
    const dir = join(CACHE, 'repos', repo.replace('/', '__'))
    if (!existsSync(join(dir, '.git'))) {
      await mkdir(dirname(dir), { recursive: true })
      await git(CACHE, 'clone', '--quiet', `https://github.com/${repo}.git`, dir)
    }
    return dir
  })()
  clones.set(repo, p)
  return p
}

const ensureCommits = async (clone: string, task: Task): Promise<void> => {
  const missing = async () =>
    !(await hasCommit(clone, task.baseCommit)) || !(await hasCommit(clone, task.referenceHead))
  if (!(await missing())) return
  await git(clone, 'fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*',
    `+refs/pull/${task.referencePr}/head:refs/remotes/origin/pr/${task.referencePr}`)
  if (await missing()) throw new Error(`${task.repo} does not hold ${task.baseCommit} and ${task.referenceHead}`)
}

// ── Checks ───────────────────────────────────────────────────────

const failures = (out: string): string | undefined => {
  const fail = out.match(/^\s*(\d+) fail\s*$/m)
  if (fail) return `${fail[1]} fail`
  const errors = out.match(/^\s*(\d+) errors?\s*$/m)
  if (errors) return `${errors[1]} error`
  return undefined
}

// A test file that cannot even load fails for the wrong reason: it names a module or an export
// the base lacks, so it measures whether the agent guessed a file name, not the behaviour.
const LOAD_ERRORS = [
  /Cannot find module/,
  /Export named '[^']+' not found/,
  /Unhandled error between tests/,
  /SyntaxError:/,
]

export const loadError = (out: string): string | undefined =>
  LOAD_ERRORS.find(re => re.test(out))?.source

const runChecks = async (task: Task, cwd: string): Promise<CheckRun> => {
  const started = performance.now()
  let output = ''
  for (const check of task.checks) {
    const r = await exec(['sh', '-c', check], cwd)
    output += `$ ${check}\n${r.out}\n`
    if (r.code !== 0) {
      const load = loadError(r.out)
      return { ok: false, ms: performance.now() - started, failed: load ? 'load error' : failures(r.out) ?? `exit ${r.code}`, loadError: load !== undefined, output }
    }
  }
  return { ok: true, ms: performance.now() - started, loadError: false, output }
}

const applyTestFiles = async (task: Task, work: string): Promise<void> => {
  for (const file of task.testFiles) {
    const r = Bun.spawnSync(['git', 'show', `${task.referenceHead}:${file}`], { cwd: work })
    if (r.exitCode !== 0) throw new Error(`${file} does not exist at ${task.referenceHead}`)
    await mkdir(dirname(join(work, file)), { recursive: true })
    await Bun.write(join(work, file), r.stdout)
  }
}

const verifyTask = async (task: Task): Promise<TaskResult> => {
  const clone = await cachedClone(task.repo)
  await ensureCommits(clone, task)
  const work = await mkdtemp(join(tmpdir(), `bench-${task.id}-`))
  await rm(work, { recursive: true, force: true })
  try {
    await git(clone, 'worktree', 'add', '--quiet', '--detach', work, task.baseCommit)
    // (a) the reference tests on the code before the fix: they must fail
    await applyTestFiles(task, work)
    const a = await runChecks(task, work)
    // (b) the full reference solution: the same checks must pass
    await git(work, 'reset', '--quiet', '--hard')
    await git(work, 'clean', '--quiet', '-fd')
    await git(work, 'checkout', '--quiet', '--detach', task.referenceHead)
    const b = await runChecks(task, work)
    return { task, a, b }
  } finally {
    await exec(['git', 'worktree', 'remove', '--force', work], clone)
    await rm(work, { recursive: true, force: true })
    await exec(['git', 'worktree', 'prune'], clone)
  }
}

// ── Report ───────────────────────────────────────────────────────

const secs = (ms?: number): string => (ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`)

const passed = (r: TaskResult): boolean => r.a?.ok === false && !r.a.loadError && r.b?.ok === true

const table = (results: TaskResult[]): string => {
  const rows = [
    ['id', 'repo#pr', 'size', 'a: fails', 'a time', 'b: passes', 'b time', ''],
    ...results.map(r => [
      r.task.id,
      `${r.task.repo.split('/')[1]}#${r.task.referencePr}`,
      r.task.sizeClass,
      r.a === undefined ? '?' : r.a.ok ? '✗ passed' : r.a.loadError ? '✗ load error' : `✓ ${r.a.failed ?? ''}`.trim(),
      secs(r.a?.ms),
      r.b === undefined ? '?' : r.b.ok ? '✓' : `✗ ${r.b.failed ?? ''}`.trim(),
      secs(r.b?.ms),
      r.error ?? '',
    ]),
  ]
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(row => (row[i] ?? '').length)))
  const line = (row: string[]) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd()
  return [line(rows[0]!), widths.map(w => '─'.repeat(w)).join('  '), ...rows.slice(1).map(line)].join('\n')
}

const parseArgs = (argv: string[]): { only: string[], verbose: boolean } => {
  const only: string[] = []
  let verbose = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--only') {
      const id = argv[++i]
      if (!id) throw new Error('--only needs a task id')
      only.push(id)
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return { only, verbose }
}

const main = async (): Promise<number> => {
  const { only, verbose } = parseArgs(process.argv.slice(2))
  const all = await loadTasks()
  const unknown = only.filter(id => !all.some(t => t.id === id))
  if (unknown.length) throw new Error(`unknown task: ${unknown.join(', ')}`)
  const tasks = only.length ? all.filter(t => only.includes(t.id)) : all

  const started = performance.now()
  const results: TaskResult[] = []
  for (const task of tasks) {
    process.stdout.write(`[bench] ${task.id} (${task.repo}#${task.referencePr}) … `)
    let result: TaskResult
    try {
      result = await verifyTask(task)
    } catch (e) {
      result = { task, error: e instanceof Error ? e.message.split('\n')[0] : String(e) }
    }
    results.push(result)
    console.log(result.error ? `error: ${result.error}` : passed(result) ? 'ok' : 'NOT OK')
    if (verbose || (!result.error && !passed(result))) {
      if (result.a) console.log(`── (a) tests only ──\n${result.a.output}`)
      if (result.b) console.log(`── (b) reference head ──\n${result.b.output}`)
    }
  }

  console.log(`\n${table(results)}\n`)
  const bad = results.filter(r => !passed(r))
  console.log(`${results.length - bad.length}/${results.length} tasks discriminating and solvable in ${secs(performance.now() - started)}`)
  return bad.length ? 1 : 0
}

if (import.meta.main) {
  main().then(code => process.exit(code), (e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(2)
  })
}
