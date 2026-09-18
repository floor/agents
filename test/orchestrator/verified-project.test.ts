import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentDefinition, CompanyConfig, ExecutionState, GitAdapter, Issue, LLMAdapter, ProjectConfig, TaskAdapter } from '@floor-agents/core'
import { loadCompanyConfig } from '@floor-agents/core'
import { createStateStore, createCostTracker, executeTask, freshState, historyOf, runNativeDevAgent, verifyFailedReport, verifyPreservedAttempt, verifyRefusal, resetLifecycle, stopChildren, STOPPED_BY_ENGINE } from '@floor-agents/orchestrator'
import { createContextBuilder } from '@floor-agents/context-builder'
import { commitWorktree, createWorktree, gitText } from '../../packages/orchestrator/src/worktree.ts'
import { validateWorktree, verifyWorktree, runProjectCommand } from '../../packages/orchestrator/src/verification.ts'
import { verifyAndCommit } from '../../packages/orchestrator/src/verified-commit.ts'
import { openAttempt } from '../../packages/orchestrator/src/attempts.ts'
import { agentSignature, sign } from '../../packages/orchestrator/src/comment-signature.ts'
import { sandboxAvailable } from '../helpers/sandbox.ts'

// Project commands run inside sandbox-exec. Where that cannot run — not macOS,
// or nested inside the engine's own verification (macOS refuses to nest
// sandbox-exec) — these tests exercise the same pipeline uncontained.
if (!sandboxAvailable()) process.env.FLOOR_AGENTS_SANDBOX = 'off'

let dir: string
let root: string
let remote: string
let project: ProjectConfig
let company: CompanyConfig
const branch = 'agent/test-change'
const issue: Issue = { id: '42', title: 'Fix the answer', body: 'Correct answer.txt', labels: [], status: 'backlog', createdAt: new Date(), updatedAt: new Date() }
const agent: AgentDefinition = { id: 'developer', name: 'Developer', promptTemplate: '', llm: { provider: 'mock', model: 'mock', temperature: 0, maxTokens: 100 }, capabilities: ['write_code'], autonomy: 'T1', customInstructions: '' }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'floor-verified-'))
  root = join(dir, 'second-project')
  remote = join(dir, 'remote.git')
  await mkdir(remote)
  await gitText(remote, ['init', '--bare', '--initial-branch=main'])
  await gitText(dir, ['clone', remote, root])
  await gitText(root, ['config', 'user.email', 'test@example.test'])
  await gitText(root, ['config', 'user.name', 'Test'])
  await Bun.write(join(root, 'answer.txt'), 'wrong')
  await Bun.write(join(root, '.env.secret'), 'fixture')
  await Bun.write(join(root, '.gitignore'), '.agents/*\n!.agents/agents.yaml\n')
  await Bun.write(join(root, 'check.mjs'), 'import { readFileSync } from "node:fs"; console.log("checking answer"); process.exit(readFileSync("answer.txt", "utf8") === "42" ? 0 : 1)')
  await gitText(root, ['add', '-A'])
  await gitText(root, ['commit', '-m', 'initial'])
  await gitText(root, ['push', 'origin', 'main'])
  await gitText(root, ['push', 'origin', `HEAD:refs/heads/${branch}`])
  company = await loadCompanyConfig('config/templates/default.yaml')
  project = { ...company.project, root, repo: 'second-project', baseBranch: 'main', setup: [], verification: [{ name: 'Answer check', command: [process.execPath, 'check.mjs'] }] }
  company = { ...company, project, agents: [agent] }
  await mkdir(join(dir, 'state'))
})

afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function state(): ExecutionState {
  return { issueId: issue.id, agentId: agent.id, step: 'calling_llm', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), branchName: branch, commitSha: null, prId: null, prUrl: null, llmResponse: null, parsedOutput: null, reviewVerdict: null, reviewCycle: 0, costUsd: 0, error: null }
}

const remoteHead = () => gitText(remote, ['rev-parse', `refs/heads/${branch}`])

test('uses the configured second checkout and publishes only the verified tree', async () => {
  const original = process.cwd()
  const worktree = await createWorktree(branch, root)
  expect(worktree.path.startsWith(root)).toBe(true)
  expect(process.cwd()).toBe(original)
  await Bun.write(join(worktree.path, 'answer.txt'), '42')
  const store = createStateStore(join(dir, 'state'))
  const next = await verifyAndCommit(worktree, project, company.guardrails, state(), store, 'fix answer')
  expect(next.verification?.passed).toBe(true)
  expect(next.verification?.checks[0]?.stdout).toContain('checking answer')
  expect(await remoteHead()).toBe(next.commitSha!)
  expect(await gitText(remote, ['rev-parse', `${next.commitSha}^{tree}`])).toBe(next.verification!.treeSha)
  expect(await Bun.file(join(root, 'answer.txt')).text()).toBe('wrong')
  expect((await store.get(issue.id))?.verification?.commitSha).toBe(next.commitSha!)
})

test('failed engine checks preserve logs and never push', async () => {
  const before = await remoteHead()
  const worktree = await createWorktree(branch, root)
  await Bun.write(join(worktree.path, 'answer.txt'), 'still wrong')
  const store = createStateStore(join(dir, 'state'))
  await expect(verifyAndCommit(worktree, project, company.guardrails, state(), store, 'bad answer')).rejects.toThrow('Verification failed')
  expect(await remoteHead()).toBe(before)
  expect((await store.get(issue.id))?.verification?.checks[0]?.exitCode).toBe(1)
  expect(await Bun.file(join(worktree.path, 'answer.txt')).exists()).toBe(true)
})

test('a run records its attempt, and a retry adds a second one to the same history', async () => {
  const store = createStateStore(join(dir, 'state'))
  const nativeAgent: AgentDefinition = { ...agent, llm: { ...agent.llm, provider: 'cursor' } }
  const { task, git } = adapters('42')
  const deps = (answer: string) => ({
    company, taskAdapter: task, gitAdapter: git, stateStore: store, costTracker: createCostTracker(),
    contextBuilder: { build: async () => ({ systemPrompt: 'sys', userMessage: '', tools: [], estimatedTokens: 0 }) },
    getAdapter: () => { throw new Error('unused') }, findReviewer: () => undefined,
    runAgent: async (_prompt: string, cwd: string) => {
      await Bun.write(join(cwd, 'answer.txt'), answer)
      return { resultText: `wrote ${answer}`, cost: 0, durationMs: 1_234, exitCode: 0 }
    },
  })

  await executeTask(issue, nativeAgent, deps('41'))
  const failed = (await store.get(issue.id))!
  expect(failed.step).toBe('failed')
  expect(failed.attempts).toHaveLength(1)
  expect(failed.attempts![0]).toMatchObject({ n: 1, kind: 'implement', agentId: 'developer', turnMs: 1_234, reply: 'wrote 41', outcome: 'gate-failed' })
  expect(failed.attempts![0]!.gates[0]!.passed).toBe(false)
  // The tree of a failed attempt is the work: it is kept, and the record says where.
  expect(await Bun.file(join(failed.attempts![0]!.worktreePath!, 'answer.txt')).text()).toBe('41')

  await executeTask(issue, nativeAgent, deps('42'), freshState(issue.id, nativeAgent.id, historyOf(failed)))
  const done = (await store.get(issue.id))!
  expect(done.step).toBe('done')
  expect(done.attempts!.map(a => [a.n, a.outcome])).toEqual([[1, 'gate-failed'], [2, 'published']])
  expect(done.attempts![1]!.worktreePath).toBeUndefined()
  expect(done.attempts![1]!.commitSha).toBe(done.commitSha!)
})

describe('verify: a preserved tree taken forward without another turn', () => {
  const nativeAgent: AgentDefinition = { ...agent, llm: { ...agent.llm, provider: 'cursor' } }
  const pipelineDeps = (store: ReturnType<typeof createStateStore>, answer: string, guardrails = company.guardrails) => {
    const { task, git } = adapters('42')
    return {
      company: { ...company, guardrails }, taskAdapter: task, gitAdapter: git, stateStore: store, costTracker: createCostTracker(),
      contextBuilder: { build: async () => ({ systemPrompt: 'sys', userMessage: '', tools: [], estimatedTokens: 0 }) },
      getAdapter: () => { throw new Error('unused') }, findReviewer: () => undefined,
      runAgent: async (_prompt: string, cwd: string) => {
        await Bun.write(join(cwd, 'answer.txt'), answer)
        return { resultText: `wrote ${answer}`, cost: 0, durationMs: 1_000, exitCode: 0 }
      },
    }
  }
  const verifyDeps = (store: ReturnType<typeof createStateStore>, comments: string[], guardrails = company.guardrails) => ({
    contextBuilder: { build: async () => ({ systemPrompt: 'sys', userMessage: '', tools: [], estimatedTokens: 0 }) },
    stateStore: store, costTracker: createCostTracker(), project, guardrails,
    addComment: async (_id: string, text: string) => { comments.push(text) }, setLabel: async () => {},
  })

  test('a tree stopped by a guardrail is published once the guardrail is raised — the agent does not run again', async () => {
    const store = createStateStore(join(dir, 'state'))
    const strict = { ...company.guardrails, blockedPaths: [...company.guardrails.blockedPaths, 'answer.txt'] }
    let turns = 0
    const deps = pipelineDeps(store, '42', strict)
    await executeTask(issue, nativeAgent, { ...deps, runAgent: async (p: string, cwd: string) => { turns++; return deps.runAgent(p, cwd) } })
    const stopped = (await store.get(issue.id))!
    expect(stopped.step).toBe('failed')
    expect(stopped.attempts![0]).toMatchObject({ outcome: 'guardrail', gates: [] })
    const kept = stopped.attempts![0]!.worktreePath!

    expect(verifyRefusal(stopped, p => p === kept)).toBeNull()
    const comments: string[] = []
    // verify runs in a new process, with a cost tracker that starts at zero: what the turns cost must survive it.
    const verified = await verifyPreservedAttempt(issue, nativeAgent, { ...stopped, costUsd: 1.5 }, verifyDeps(store, comments))
    expect(verified.costUsd).toBe(1.5)
    expect(verified.step).toBe('creating_pr')
    expect(verified.error).toBeNull()
    expect(verified.attempts).toHaveLength(1)
    expect(verified.attempts![0]).toMatchObject({ n: 1, outcome: 'published', commitSha: verified.commitSha! })
    expect(verified.attempts![0]!.gates.map(g => g.passed)).toEqual([true])
    expect(verified.attempts![0]!.worktreePath).toBeUndefined()
    expect(await Bun.file(join(kept, 'answer.txt')).exists()).toBe(false)
    // The run names its own branch (agent/<issue>-<title>), not the fixture's.
    expect(await gitText(remote, ['rev-parse', `refs/heads/${verified.branchName}`])).toBe(verified.commitSha!)
    expect(comments[0]).toContain('Attempt 1** re-verified and published, without another turn')

    // The rest is the ordinary path, from the pull request on.
    await executeTask(issue, nativeAgent, pipelineDeps(store, 'unused'), verified)
    expect((await store.get(issue.id))!.step).toBe('done')
    expect(turns).toBe(1)
  })

  test('a tree that still fails stays kept: a second gate run on the same attempt, the run failed again', async () => {
    const store = createStateStore(join(dir, 'state'))
    await executeTask(issue, nativeAgent, pipelineDeps(store, '41'))
    const failed = (await store.get(issue.id))!
    await expect(verifyPreservedAttempt(issue, nativeAgent, failed, verifyDeps(store, []))).rejects.toThrow('Verification failed: Answer check')
    const after = (await store.get(issue.id))!
    expect(after.step).toBe('failed')
    expect(after.attempts![0]!.outcome).toBe('gate-failed')
    expect(after.attempts![0]!.gates.map(g => g.passed)).toEqual([false, false])
    expect(await Bun.file(join(after.attempts![0]!.worktreePath!, 'answer.txt')).text()).toBe('41')
    expect(verifyFailedReport(1, after.error!, after.attempts![0]!.gates.at(-1)!.checks[0], 'FLO-1')).toContain('floor-agents verify --issue FLO-1')
  })

  test('a branch that moved since the attempt began makes its tree stale: refused, the record untouched', async () => {
    const store = createStateStore(join(dir, 'state'))
    await executeTask(issue, nativeAgent, pipelineDeps(store, '41'))
    const failed = (await store.get(issue.id))!
    await Bun.write(join(root, 'other.txt'), 'someone else')
    await gitText(root, ['add', '-A'])
    await gitText(root, ['commit', '-m', 'the branch moves'])
    await gitText(root, ['push', 'origin', `HEAD:refs/heads/${failed.branchName}`])
    await expect(verifyPreservedAttempt(issue, nativeAgent, failed, verifyDeps(store, []))).rejects.toThrow(/branch moved since attempt 1 began/)
    expect((await store.get(issue.id))!.attempts![0]!.gates).toHaveLength(1)
  })

  test('what cannot be verified says why', () => {
    const base = { ...state(), step: 'failed' as const }
    expect(verifyRefusal(null, () => true)).toContain('no run is recorded')
    expect(verifyRefusal({ ...base, step: 'done' }, () => true)).toContain('not failed')
    expect(verifyRefusal(base, () => true)).toContain('predates the attempt record')
    const kept = openAttempt(base, { kind: 'implement', agentId: 'developer', model: 'm', baseSha: 'b', initialSha: 'i', worktreePath: '/gone' })
    expect(verifyRefusal(kept, () => false)).toContain("tree is gone")
    expect(verifyRefusal(kept, () => true)).toBeNull()
  })
})

test('a failed gate and a published tree are both in the history', async () => {
  const store = createStateStore(join(dir, 'state'))
  const worktree = await createWorktree(branch, root)
  await Bun.write(join(worktree.path, 'answer.txt'), '41')
  const opened = openAttempt(state(), { kind: 'implement', agentId: agent.id, model: 'mock', baseSha: worktree.initialSha, worktreePath: worktree.path })
  await expect(verifyAndCommit(worktree, project, company.guardrails, opened, store, 'wrong')).rejects.toThrow('Verification failed')
  const failed = (await store.get(issue.id))!
  expect(failed.attempts![0]!.gates).toHaveLength(1)
  expect(failed.attempts![0]!.gates[0]).toMatchObject({ passed: false, checks: [{ name: 'Answer check', exitCode: 1 }] })
  expect(failed.attempts![0]!.gates[0]!.checks[0]!.tail).toContain('checking answer')

  // The same attempt, corrected: the second gate run joins the first.
  await Bun.write(join(worktree.path, 'answer.txt'), '42')
  const published = await verifyAndCommit(worktree, project, company.guardrails, failed, store, 'right')
  expect(published.attempts![0]!.gates.map(g => g.passed)).toEqual([false, true])
  expect(published.commitSha).toBe(await remoteHead())
})

test('size guardrails measure the change, not the files it touches', async () => {
  // A one-line entry in a changelog far over the per-file cap is a small change…
  await Bun.write(join(root, 'CHANGELOG.md'), `# Changelog\n${'- an old entry that makes this file large\n'.repeat(6000)}`)
  await gitText(root, ['add', '-A'])
  await gitText(root, ['commit', '-m', 'a large changelog'])
  await gitText(root, ['push', 'origin', `HEAD:refs/heads/${branch}`, '--force'])
  const worktree = await createWorktree(branch, root)
  const log = join(worktree.path, 'CHANGELOG.md')
  expect((await Bun.file(log).text()).length).toBeGreaterThan(company.guardrails.maxFileSizeBytes)
  await Bun.write(log, (await Bun.file(log).text()).replace('# Changelog\n', '# Changelog\n- a new entry\n'))
  await validateWorktree(worktree, worktree.initialSha, company.guardrails)

  // …and a new file over the cap is still refused, with the numbers in the message.
  await Bun.write(join(worktree.path, 'generated.txt'), 'x'.repeat(company.guardrails.maxFileSizeBytes + 1))
  await expect(validateWorktree(worktree, worktree.initialSha, company.guardrails)).rejects.toThrow(/adds \d+ bytes to generated\.txt, over maxFileSizeBytes/)
  await rm(join(worktree.path, 'generated.txt'))

  // The total is the sum of the changes.
  // The total is the sum of what was added: that entry is 14 bytes.
  const tight = { ...company.guardrails, maxTotalOutputBytes: 10 }
  await expect(validateWorktree(worktree, worktree.initialSha, tight)).rejects.toThrow(/adds 14 bytes across 1 files, over maxTotalOutputBytes \(10\)/)
})

test('only what a change adds is measured: a deletion writes nothing, a rewrite is not counted twice', async () => {
  // Both failed the day the patch measure shipped: deleting a 300 KB file was
  // refused, and rewriting 70 KB of a file measured 154 KB (removed + added + context).
  await Bun.write(join(root, 'generated.txt'), `${'g'.repeat(300_000)}\n`)
  await Bun.write(join(root, 'big.md'), `${Array.from({ length: 4000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')}\n`)
  await gitText(root, ['add', '-A'])
  await gitText(root, ['commit', '-m', 'large files'])
  await gitText(root, ['push', 'origin', `HEAD:refs/heads/${branch}`, '--force'])
  const worktree = await createWorktree(branch, root)

  await rm(join(worktree.path, 'generated.txt'))
  await validateWorktree(worktree, worktree.initialSha, company.guardrails)

  // Moving a large file unchanged writes nothing either; a small new file whose
  // line begins like a patch header is counted as the 42 bytes it is.
  await mkdir(join(worktree.path, 'docs'))
  await rename(join(worktree.path, 'big.md'), join(worktree.path, 'docs', 'big.md'))
  await Bun.write(join(worktree.path, 'notes.md'), '++ a line that begins like a patch header\n')
  await validateWorktree(worktree, worktree.initialSha, { ...company.guardrails, maxFileSizeBytes: 50_000 })
  await expect(validateWorktree(worktree, worktree.initialSha, { ...company.guardrails, maxTotalOutputBytes: 10 })).rejects.toThrow(/adds 42 bytes across 4 files/)
  await rm(join(worktree.path, 'notes.md'))
  await rename(join(worktree.path, 'docs', 'big.md'), join(worktree.path, 'big.md'))

  const big = join(worktree.path, 'big.md')
  await Bun.write(big, (await Bun.file(big).text()).split('\n').map((l, i) => i < 1500 ? l.replace('line', 'LINE') : l).join('\n'))
  await validateWorktree(worktree, worktree.initialSha, company.guardrails)
  // …measured as the ~77 KB it added: under the 100 KB cap, over an 80 KB total.
  await expect(validateWorktree(worktree, worktree.initialSha, { ...company.guardrails, maxTotalOutputBytes: 60_000 })).rejects.toThrow(/adds 7\d{4} bytes across 2 files/)
})

test('blocked deletions, binary size, and symlinks fail actual-diff guardrails', async () => {
  const worktree = await createWorktree(branch, root)
  await rm(join(worktree.path, '.env.secret'))
  await expect(validateWorktree(worktree, worktree.initialSha, company.guardrails)).rejects.toThrow('blocked pattern')
  await Bun.write(join(worktree.path, '.env.secret'), 'fixture')
  await Bun.write(join(worktree.path, 'large.bin'), new Uint8Array(102401))
  await expect(validateWorktree(worktree, worktree.initialSha, company.guardrails)).rejects.toThrow('maxFileSizeBytes')
  await rm(join(worktree.path, 'large.bin'))
  await symlink('/tmp', join(worktree.path, 'outside'))
  await expect(validateWorktree(worktree, worktree.initialSha, company.guardrails)).rejects.toThrow('Unsupported file mode')
})

describe('the gate runs on a clean export of the tree, not in the agent\'s worktree', () => {
  const needsCache = { name: 'Needs the cache', command: [process.execPath, '-e', 'process.exit(require("node:fs").existsSync("cache/answer.json") ? 0 : 1)'] }
  const gateDirs = async () => (await Array.fromAsync(new Bun.Glob('gate-*').scan({ cwd: join(root, '.agents', 'worktrees'), onlyFiles: false }))).length
  const ignoreCache = async () => {
    await Bun.write(join(root, '.gitignore'), '.agents/*\n!.agents/agents.yaml\ncache/\n')
    await gitText(root, ['add', '-A'])
    await gitText(root, ['commit', '-m', 'ignore cache/'])
    await gitText(root, ['push', 'origin', `HEAD:refs/heads/${branch}`, '--force'])
  }

  test('a file the commit will not carry cannot help the gate pass', async () => {
    // Measured before the fix: this gate was green, and the published commit had no cache/answer.json.
    await ignoreCache()
    const worktree = await createWorktree(branch, root)
    await Bun.write(join(worktree.path, 'feature.txt'), 'the change')
    await Bun.write(join(worktree.path, 'cache', 'answer.json'), '{}')
    const result = await verifyWorktree(worktree, [needsCache])
    expect(result.passed).toBe(false)
    expect(result.checks[0]).toMatchObject({ name: 'Needs the cache', exitCode: 1 })
    expect(await gateDirs()).toBe(0)
  })

  test('what the change adds — tracked or new — is in the export; setup runs there first', async () => {
    await ignoreCache()
    const worktree = await createWorktree(branch, root)
    await Bun.write(join(worktree.path, 'answer.txt'), '42')
    await Bun.write(join(worktree.path, 'new-file.txt'), 'untracked until the snapshot')
    const seesBoth = { name: 'Sees the change', command: [process.execPath, '-e', 'const fs=require("node:fs"); process.exit(fs.readFileSync("answer.txt","utf8")==="42" && fs.existsSync("new-file.txt") ? 0 : 1)'] }
    const makeCache = { name: 'Build the cache', command: [process.execPath, '-e', 'require("node:fs").mkdirSync("cache"); require("node:fs").writeFileSync("cache/answer.json","{}")'] }
    const result = await verifyWorktree(worktree, [seesBoth, needsCache], [makeCache])
    expect(result.passed).toBe(true)
    expect(result.checks.map(c => c.name)).toEqual(['Sees the change', 'Needs the cache'])
    // The agent's worktree was not touched by the gate's setup.
    expect(await Bun.file(join(worktree.path, 'cache', 'answer.json')).exists()).toBe(false)
    expect(await gateDirs()).toBe(0)
  })

  test('a setup that fails is a gate that fails, and says which step', async () => {
    const worktree = await createWorktree(branch, root)
    await Bun.write(join(worktree.path, 'answer.txt'), '42')
    const broken = { name: 'Install dependencies', command: [process.execPath, '-e', 'console.error("lockfile out of date"); process.exit(3)'] }
    const result = await verifyWorktree(worktree, project.verification!, [broken])
    expect(result.passed).toBe(false)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]).toMatchObject({ name: 'Setup: Install dependencies', exitCode: 3 })
    expect(result.checks[0]!.stderr).toContain('lockfile out of date')
    expect(await gateDirs()).toBe(0)
  })
})

test('checks that edit tracked files cannot certify their new output', async () => {
  const worktree = await createWorktree(branch, root)
  const result = await verifyWorktree(worktree, [{ name: 'mutating check', command: [process.execPath, '-e', 'await Bun.write("answer.txt", "42")'] }])
  expect(result.passed).toBe(false)
  expect(result.error).toContain('modified')
})

test('post-verification edits are refused before commit', async () => {
  const worktree = await createWorktree(branch, root)
  await Bun.write(join(worktree.path, 'answer.txt'), '42')
  const result = await verifyWorktree(worktree, project.verification!)
  expect(result.passed).toBe(true)
  await Bun.write(join(worktree.path, 'answer.txt'), 'wrong again')
  await expect(commitWorktree(worktree, 'must fail', result.treeSha)).rejects.toThrow('changed after verification')
})

test('fresh remote state wins over a stale local branch and workspaces never collide', async () => {
  await gitText(root, ['branch', branch])
  const first = await createWorktree(branch, root)
  await Bun.write(join(first.path, 'answer.txt'), '42')
  await verifyAndCommit(first, project, company.guardrails, state(), createStateStore(join(dir, 'state')), 'fix')
  const second = await createWorktree(branch, root)
  expect(second.path).not.toBe(first.path)
  expect(await Bun.file(join(second.path, 'answer.txt')).text()).toBe('42')
  expect(await Bun.file(join(first.path, 'answer.txt')).exists()).toBe(true)
})

test('timeouts and missing executables fail with structured results', async () => {
  const result = await runProjectCommand(root, { name: 'timeout', command: [process.execPath, '-e', 'await Bun.sleep(10000)'], timeoutMs: 40 })
  expect(result.timedOut).toBe(true)
  expect(result.exitCode).not.toBe(0)
  // A long run says why it failed at the end: 200 KB of passing tests must not push the reason out of the record.
  const long = await runProjectCommand(root, { name: 'long', command: [process.execPath, '-e', 'console.log("first line"); for (let i = 0; i < 4000; i++) console.log("ok ".repeat(16)); console.log("1 fail: expected 42"); process.exit(1)'] })
  expect(long.exitCode).toBe(1)
  expect(long.stdout.startsWith('first line')).toBe(true)
  expect(long.stdout.trimEnd().endsWith('1 fail: expected 42')).toBe(true)
  expect(long.stdout).toMatch(/\[… \d+ characters omitted …\]/)
  expect(long.stdout.length).toBeLessThan(34_000)
  const missing = await runProjectCommand(root, { name: 'missing', command: ['floor-command-does-not-exist'] })
  expect(missing.exitCode).not.toBe(0)
})

test('native executor runs independent checks even if its agent claims success', async () => {
  const store = createStateStore(join(dir, 'state'))
  const before = await remoteHead()
  await expect(runNativeDevAgent(issue, agent, state(), {
    project, guardrails: company.guardrails, stateStore: store, costTracker: createCostTracker(),
    addComment: async () => {}, setLabel: async () => {},
    contextBuilder: { build: async () => ({ systemPrompt: '', userMessage: '', tools: [], estimatedTokens: 0 }) },
    runAgent: async (_prompt, cwd) => {
      await Bun.write(join(cwd, 'answer.txt'), 'incorrect')
      return { resultText: 'Everything passes!', cost: 0, durationMs: 1, exitCode: 0 }
    },
  })).rejects.toThrow('Verification failed')
  expect(await remoteHead()).toBe(before)
  const saved = await store.get(issue.id)
  expect(saved?.verification?.passed).toBe(false)
  expect(await Bun.file(join(saved!.workspacePath!, 'answer.txt')).exists()).toBe(true)
})

test('a terminated native agent cannot publish partial work', async () => {
  const before = await remoteHead()
  await expect(runNativeDevAgent(issue, agent, state(), {
    project, guardrails: company.guardrails, stateStore: createStateStore(join(dir, 'state')), costTracker: createCostTracker(),
    addComment: async () => {}, setLabel: async () => {},
    contextBuilder: { build: async () => ({ systemPrompt: '', userMessage: '', tools: [], estimatedTokens: 0 }) },
    runAgent: async (_prompt, cwd) => {
      await Bun.write(join(cwd, 'answer.txt'), '42')
      return { resultText: 'partial work', cost: 0, durationMs: 1, exitCode: 143 }
    },
  })).rejects.toThrow('did not finish within')
  expect(await remoteHead()).toBe(before)
})

function adapters(answer: string) {
  const comments: string[] = []
  const prs: string[] = []
  const task: TaskAdapter = {
    async *watchIssues() {}, getIssue: async () => issue, createIssue: async () => issue,
    updateIssue: async () => {}, addComment: async (_id, text) => { comments.push(text) },
    setStatus: async () => {}, setLabel: async () => {}, removeLabel: async () => {},
  }
  const git: GitAdapter = {
    getFile: async () => null, getTree: async () => [],
    createBranch: async (_repo, name) => { await gitText(root, ['push', 'origin', `main:refs/heads/${name}`]) },
    commitFiles: async () => { throw new Error('Verified API writes must use the local gate') },
    createPR: async (_repo, name, title, body, baseBranch) => {
      expect(baseBranch).toBe('main')
      prs.push(body)
      return { id: '1', url: 'https://example.test/pr/1', title, body, branch: name, status: 'open' }
    },
    getRecentCommits: async () => [], getPRDiff: async () => '', addPRComment: async () => {}, mergePR: async () => {},
  }
  const llm: LLMAdapter = { run: async () => ({ content: 'finished', toolCalls: [
    { id: '1', name: 'write_file', input: { path: 'answer.txt', content: answer } },
    { id: '2', name: 'pr_description', input: { title: 'Fix answer', description: 'Fix the answer.' } },
  ], stopReason: 'end_turn', usage: { cost: 0, inputTokens: 0, outputTokens: 0 }, provider: 'mock', model: 'mock', durationMs: 1 }) }
  return { task, git, llm, comments, prs }
}

for (const answer of ['42', 'wrong']) test(`full API task pipeline only opens PR after passing checks (${answer})`, async () => {
  const { task, git, llm, prs } = adapters(answer)
  const store = createStateStore(join(dir, 'state'))
  await executeTask(issue, agent, {
    company, taskAdapter: task, gitAdapter: git, stateStore: store, costTracker: createCostTracker(),
    contextBuilder: createContextBuilder({ taskAdapter: task, gitAdapter: git }), getAdapter: () => llm, findReviewer: () => undefined,
  })
  const saved = await store.get(issue.id)
  expect(saved?.step).toBe(answer === '42' ? 'done' : 'failed')
  expect(prs).toHaveLength(answer === '42' ? 1 : 0)
  expect(saved?.verification?.passed).toBe(answer === '42')
  if (answer === '42') expect(prs[0]).toContain('Engine verification: PASSED')
  else expect(saved?.verification?.checks[0]?.exitCode).toBe(1)
})

test('native successful execution publishes engine evidence and removes its workspace', async () => {
  const store = createStateStore(join(dir, 'state'))
  const next = await runNativeDevAgent(issue, agent, state(), {
    project, guardrails: company.guardrails, stateStore: store, costTracker: createCostTracker(),
    addComment: async () => {}, setLabel: async () => {},
    contextBuilder: { build: async () => ({ systemPrompt: '', userMessage: '', tools: [], estimatedTokens: 0 }) },
    runAgent: async (_prompt, cwd) => {
      await Bun.write(join(cwd, 'answer.txt'), '42')
      return { resultText: 'Implemented', cost: 0.1, durationMs: 1, exitCode: 0 }
    },
  })
  expect(next.step).toBe('creating_pr')
  expect(next.costUsd).toBe(0.1)
  expect(next.verification?.commitSha).toBe(await remoteHead())
  expect(await Bun.file(join(next.workspacePath!, 'answer.txt')).exists()).toBe(false)
})

test('concurrent remote updates reject the push and preserve the second workspace', async () => {
  const first = await createWorktree(branch, root)
  const second = await createWorktree(branch, root)
  await Bun.write(join(first.path, 'answer.txt'), '42')
  await Bun.write(join(second.path, 'answer.txt'), '42')
  await Bun.write(join(second.path, 'extra.txt'), 'second attempt')
  const store = createStateStore(join(dir, 'state'))
  const accepted = await verifyAndCommit(first, project, company.guardrails, state(), store, 'first')
  await expect(verifyAndCommit(second, project, company.guardrails, state(), store, 'second')).rejects.toThrow('git push failed')
  expect(await remoteHead()).toBe(accepted.commitSha!)
  expect(await Bun.file(join(second.path, 'extra.txt')).exists()).toBe(true)
})

test('remote changes after PR creation prevent a stale completion claim', async () => {
  const { task, git, llm } = adapters('42')
  const originalCreatePR = git.createPR
  git.createPR = async (...args) => {
    const pr = await originalCreatePR(...args)
    const branchName = args[1]
    const before = await gitText(remote, ['rev-parse', `refs/heads/${branchName}`])
    const tree = await gitText(root, ['rev-parse', 'main^{tree}'])
    const changed = await gitText(root, ['commit-tree', tree, '-p', before, '-m', 'external change'])
    await gitText(root, ['push', 'origin', `${changed}:refs/heads/${branchName}`])
    return pr
  }
  const store = createStateStore(join(dir, 'state'))
  await executeTask(issue, agent, {
    company, taskAdapter: task, gitAdapter: git, stateStore: store, costTracker: createCostTracker(),
    contextBuilder: createContextBuilder({ taskAdapter: task, gitAdapter: git }), getAdapter: () => llm, findReviewer: () => undefined,
  })
  expect((await store.get(issue.id))?.step).toBe('failed')
  expect((await store.get(issue.id))?.error).toContain('Remote branch changed')
})


test('exhausted review cycles report failure instead of a successful one-shot run', async () => {
  const { task, git, llm, prs } = adapters('42')
  const store = createStateStore(join(dir, 'state'))
  const reviewer: AgentDefinition = { ...agent, id: 'reviewer', capabilities: ['review_pr'] }
  const existing = { ...state(), step: 'revision' as const, reviewCycle: 3, reviewVerdict: { decision: 'request_changes' as const, comments: 'Still incorrect' } }
  await store.save(existing)
  await executeTask(issue, agent, {
    company, taskAdapter: task, gitAdapter: git, stateStore: store, costTracker: createCostTracker(),
    contextBuilder: createContextBuilder({ taskAdapter: task, gitAdapter: git }), getAdapter: () => llm, findReviewer: () => reviewer,
  }, existing)
  expect((await store.get(issue.id))?.step).toBe('failed')
  expect((await store.get(issue.id))?.error).toContain('Max review cycles')
  expect(prs).toHaveLength(0)
})

test('the native implementer prompt includes the issue discussion, and nothing when there is none', async () => {
  const nativeAgent: AgentDefinition = { ...agent, llm: { ...agent.llm, provider: 'cursor' } }
  const grok = { name: 'Grok', llm: { model: 'cursor-grok-4.6-high', provider: 'cursor' } } as never
  const prompts: string[] = []
  const { task, git } = adapters('42')
  task.getComments = async () => [
    { id: '1', author: 'jvial', body: 'start from the tests this time', createdAt: new Date('2026-09-18T00:00:00Z') },
    { id: '2', author: 'bot', body: sign('⏳ working on the code...', agentSignature(grok, 'implementer')), createdAt: new Date('2026-09-18T01:00:00Z') },
  ]
  await executeTask(issue, nativeAgent, {
    company, taskAdapter: task, gitAdapter: git, stateStore: createStateStore(join(dir, 'state')),
    costTracker: createCostTracker(),
    contextBuilder: { build: async () => ({ systemPrompt: 'sys', userMessage: '', tools: [], estimatedTokens: 0 }) },
    getAdapter: () => { throw new Error('unused') }, findReviewer: () => undefined,
    runAgent: async (prompt, cwd) => {
      prompts.push(prompt)
      await Bun.write(join(cwd, 'answer.txt'), '42')
      return { resultText: 'done', cost: 0, durationMs: 1, exitCode: 0 }
    },
  })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]!.indexOf('Correct answer.txt')).toBeLessThan(prompts[0]!.indexOf('## Discussion'))
  expect(prompts[0]!).toContain('start from the tests this time')
  expect(prompts[0]!).not.toContain('working on the code')
  expect(prompts[0]!).not.toContain('## Review Feedback')

  prompts.length = 0
  const quiet = adapters('42')
  await mkdir(join(dir, 'state-empty'), { recursive: true })
  const quietIssue = { ...issue, id: '43' }
  await executeTask(quietIssue, nativeAgent, {
    company, taskAdapter: quiet.task, gitAdapter: quiet.git, stateStore: createStateStore(join(dir, 'state-empty')),
    costTracker: createCostTracker(),
    contextBuilder: { build: async () => ({ systemPrompt: 'sys', userMessage: '', tools: [], estimatedTokens: 0 }) },
    getAdapter: () => { throw new Error('unused') }, findReviewer: () => undefined,
    runAgent: async (prompt, cwd) => {
      prompts.push(prompt)
      await Bun.write(join(cwd, 'answer.txt'), '42')
      return { resultText: 'done', cost: 0, durationMs: 1, exitCode: 0 }
    },
  })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]!).not.toContain('## Discussion')
})

test('a comments outage is logged and the native turn still runs', async () => {
  const nativeAgent: AgentDefinition = { ...agent, llm: { ...agent.llm, provider: 'cursor' } }
  const prompts: string[] = []
  const { task, git } = adapters('42')
  task.getComments = async () => { throw new Error('Linear unavailable') }
  await executeTask(issue, nativeAgent, {
    company, taskAdapter: task, gitAdapter: git, stateStore: createStateStore(join(dir, 'state')),
    costTracker: createCostTracker(),
    contextBuilder: { build: async () => ({ systemPrompt: 'sys', userMessage: '', tools: [], estimatedTokens: 0 }) },
    getAdapter: () => { throw new Error('unused') }, findReviewer: () => undefined,
    runAgent: async (prompt, cwd) => {
      prompts.push(prompt)
      await Bun.write(join(cwd, 'answer.txt'), '42')
      return { resultText: 'done', cost: 0, durationMs: 1, exitCode: 0 }
    },
  })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]!).not.toContain('## Discussion')
})

test('the native implementer prompt never names API-path tools, on a first pass or a revision', async () => {
  const nativeDev: AgentDefinition = { ...agent, promptTemplate: join(process.cwd(), 'agents/backend-dev.md') }
  const template = await Bun.file(nativeDev.promptTemplate).text()
  expect(template).toContain('write_file')
  expect(template).toContain('pr_description')
  expect(template).toContain('FULL file contents')

  const capture = async (reviewComments?: string): Promise<string> => {
    let prompt = ''
    const { task, git } = adapters('42')
    try {
      await runNativeDevAgent(issue, nativeDev, state(), {
        project, guardrails: company.guardrails, stateStore: createStateStore(join(dir, 'state')),
        costTracker: createCostTracker(), addComment: async () => {}, setLabel: async () => {},
        contextBuilder: createContextBuilder({ taskAdapter: task, gitAdapter: git }),
        runAgent: async (text, cwd) => {
          prompt = text
          await Bun.write(join(cwd, 'answer.txt'), '42')
          return { resultText: 'ok', cost: 0, durationMs: 1, exitCode: 0 }
        },
      }, reviewComments)
    } catch (err) {
      if (!prompt) throw err
    }
    return prompt
  }

  const first = await capture()
  const revision = await capture('please add tests')
  for (const prompt of [first, revision]) {
    expect(prompt).toContain('senior backend developer')
    expect(prompt).not.toContain('write_file')
    expect(prompt).not.toContain('pr_description')
    expect(prompt).not.toContain('FULL file contents')
    expect(prompt).not.toContain('## Output')
    expect(prompt).toContain('Do not commit, push, or open a PR')
    expect(prompt).toContain('own editing tools')
    expect(prompt).toContain('The engine reads the working tree, not your message')
  }
  expect(first).not.toContain('## Review Feedback')
  expect(revision).toContain('## Review Feedback')
})

test('discussion sits after the issue body and before review feedback', async () => {
  let prompt = ''
  try {
    await runNativeDevAgent(issue, agent, state(), {
      project, guardrails: company.guardrails, stateStore: createStateStore(join(dir, 'state')),
      costTracker: createCostTracker(), addComment: async () => {}, setLabel: async () => {},
      contextBuilder: { build: async () => ({ systemPrompt: 'sys', userMessage: '', tools: [], estimatedTokens: 0 }) },
      discussion: '## Discussion\n\n**jvial** (2026-09-18):\nstart here',
      runAgent: async (text, cwd) => {
        prompt = text
        await Bun.write(join(cwd, 'answer.txt'), '42')
        return { resultText: 'ok', cost: 0, durationMs: 1, exitCode: 0 }
      },
    }, 'please add tests')
  } catch (err) {
    if (!prompt) throw err
  }
  expect(prompt.indexOf('Correct answer.txt')).toBeLessThan(prompt.indexOf('## Discussion'))
  expect(prompt.indexOf('## Discussion')).toBeLessThan(prompt.indexOf('## Review Feedback'))
  expect(prompt).toContain('start here')
  expect(prompt).toContain('please add tests')
})

describe('a revision continues the implementer’s session', () => {
  type Call = { prompt: string; resume: string | undefined }

  /** A first pass that names its session, then a revision on the state it left. */
  async function firstPassThenRevision(
    revisionTurn: (call: Call, cwd: string, n: number) => Promise<{ resultText: string; cost: number; durationMs: number; exitCode: number; sessionId?: string }>,
  ) {
    const store = createStateStore(join(dir, 'state'))
    const base = {
      project, guardrails: company.guardrails, stateStore: store, costTracker: createCostTracker(),
      addComment: async () => {}, setLabel: async () => {},
      contextBuilder: { build: async () => ({ systemPrompt: 'THE FULL BRIEF', userMessage: '', tools: [], estimatedTokens: 0 }) },
    }
    const first = await runNativeDevAgent(issue, agent, state(), {
      ...base,
      runAgent: async (_prompt, cwd) => {
        await Bun.write(join(cwd, 'answer.txt'), '42')
        return { resultText: 'Implemented', cost: 0, durationMs: 1, exitCode: 0, sessionId: 'sess-1' }
      },
    })
    expect(first.attempts?.at(-1)).toMatchObject({ outcome: 'published', sessionId: 'sess-1' })

    const calls: Call[] = []
    const revised = await runNativeDevAgent(issue, agent, first, {
      ...base,
      discussion: '## Discussion\n\n**Owner** (2026-09-18):\nkeep it small',
      runAgent: async (prompt, cwd, _model, turn) => {
        calls.push({ prompt, resume: turn?.resume })
        return revisionTurn(calls.at(-1)!, cwd, calls.length)
      },
    }, 'BLOCKER: add a note')
    return { calls, revised }
  }

  test('it resumes the session with the feedback, not the whole brief', async () => {
    const { calls, revised } = await firstPassThenRevision(async (_call, cwd) => {
      await Bun.write(join(cwd, 'note.txt'), 'a note')
      return { resultText: 'Added the note', cost: 0, durationMs: 1, exitCode: 0, sessionId: 'sess-1' }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.resume).toBe('sess-1')
    expect(calls[0]!.prompt).not.toContain('THE FULL BRIEF')
    expect(calls[0]!.prompt).toContain('BLOCKER: add a note')
    expect(calls[0]!.prompt).toContain('keep it small')
    expect(calls[0]!.prompt).toContain('fresh checkout of your branch')
    expect(calls[0]!.prompt).toContain('Do not commit, push, or open a PR')
    expect(revised.attempts?.at(-1)).toMatchObject({ n: 2, kind: 'revision', continues: 1, outcome: 'published', sessionId: 'sess-1' })
  })

  test('a session that cannot be resumed costs seconds: the revision runs again with the full brief', async () => {
    const { calls, revised } = await firstPassThenRevision(async (call, cwd) => {
      if (call.resume) return { resultText: 'Error: session not found', cost: 0, durationMs: 900, exitCode: 1 }
      await Bun.write(join(cwd, 'note.txt'), 'a note')
      return { resultText: 'Added the note', cost: 0, durationMs: 1, exitCode: 0, sessionId: 'sess-2' }
    })
    expect(calls.map(c => c.resume)).toEqual(['sess-1', undefined])
    expect(calls[1]!.prompt).toContain('THE FULL BRIEF')
    expect(calls[1]!.prompt).toContain('BLOCKER: add a note')
    const attempt = revised.attempts!.at(-1)!
    expect(attempt.continues).toBeUndefined()
    expect(attempt).toMatchObject({ outcome: 'published', sessionId: 'sess-2' })
  })

  test('a resumed turn that worked and failed is a failed turn, not a reason to start over', async () => {
    let calls = 0
    await expect(firstPassThenRevision(async (_call, cwd) => {
      calls++
      await Bun.write(join(cwd, 'half.txt'), 'half done')
      return { resultText: 'ran out of turns', cost: 0, durationMs: 900, exitCode: 1 }
    })).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test('FLOOR_AGENTS_RESUME=off keeps the old behaviour', async () => {
    process.env.FLOOR_AGENTS_RESUME = 'off'
    try {
      const { calls } = await firstPassThenRevision(async (_call, cwd) => {
        await Bun.write(join(cwd, 'note.txt'), 'a note')
        return { resultText: 'ok', cost: 0, durationMs: 1, exitCode: 0 }
      })
      expect(calls[0]!.resume).toBeUndefined()
      expect(calls[0]!.prompt).toContain('THE FULL BRIEF')
    } finally {
      delete process.env.FLOOR_AGENTS_RESUME
    }
  })
})

describe('the engine is stopped during a turn', () => {
  afterEach(() => resetLifecycle())

  test('the turn is recorded as stopped by the engine, the task is not failed, and nobody is called', async () => {
    const { task, git, comments } = adapters('42')
    const labels: string[] = []
    task.setLabel = async (_id, label) => { labels.push(label) }
    const nativeDev: AgentDefinition = { ...agent, llm: { ...agent.llm, provider: 'cursor' } }
    const store = createStateStore(join(dir, 'state'))
    await executeTask(issue, nativeDev, {
      company, taskAdapter: task, gitAdapter: git, stateStore: store, costTracker: createCostTracker(),
      contextBuilder: createContextBuilder({ taskAdapter: task, gitAdapter: git }),
      getAdapter: () => { throw new Error('not used') }, findReviewer: () => undefined,
      runAgent: async (_prompt, cwd) => {
        await Bun.write(join(cwd, 'answer.txt'), 'half')
        await stopChildren(0) // SIGTERM arrives: the engine ends its children, the CLI dies
        return { resultText: '', cost: 0, durationMs: 5_000, exitCode: 143 }
      },
    })
    const saved = await store.get(issue.id)
    expect(saved?.step).not.toBe('failed')
    expect(saved?.error).toBeNull()
    expect(saved?.attempts?.at(-1)).toMatchObject({ outcome: 'stopped', error: STOPPED_BY_ENGINE })
    expect(labels).not.toContain('needs-human')
    expect(comments.some(c => c.includes('stopped') || c.includes('crash') || c.includes('did not finish'))).toBe(false)
  })
})
