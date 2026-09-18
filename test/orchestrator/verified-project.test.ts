import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentDefinition, CompanyConfig, ExecutionState, GitAdapter, Issue, LLMAdapter, ProjectConfig, TaskAdapter } from '@floor-agents/core'
import { loadCompanyConfig } from '@floor-agents/core'
import { createStateStore, createCostTracker, executeTask, freshState, historyOf, runNativeDevAgent } from '@floor-agents/orchestrator'
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
