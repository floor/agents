import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadCompanyConfig, validateCompanyConfig } from '@floor-agents/core'
import { initProject, doctorProject, githubRemote } from '../../src/cli/project.ts'
import { parseArgs } from '../../src/cli/args.ts'
import { gitText } from '../../packages/orchestrator/src/worktree.ts'

let dir: string
let root: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'floor-project-cli-'))
  root = join(dir, 'target')
  await mkdir(root)
  await gitText(root, ['init', '--initial-branch=main'])
  await gitText(root, ['remote', 'add', 'origin', 'git@github.com:example/target.git'])
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('init creates a portable manifest without installing or overwriting anything', async () => {
  await Bun.write(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'custom-build' } }))
  await Bun.write(join(root, 'package-lock.json'), '{}')
  const path = join(root, '.agents', 'agents.yaml')
  await initProject(path, root)
  const config = await loadCompanyConfig(path)
  expect(config.project.root).toBe(root)
  expect(config.project.owner).toBe('example')
  expect(config.project.repo).toBe('target')
  expect(config.project.baseBranch).toBe('main')
  expect(config.project.verification?.map(c => c.command)).toEqual([['npm', 'run', 'test'], ['npm', 'run', 'build']])
  expect(config.project.setup?.[0]?.command).toEqual(['npm', 'ci'])
  expect(config.agents[0]?.promptTemplate).toBe(join(root, '.agents', 'developer.md'))
  expect(validateCompanyConfig(config)).toEqual([])
  const before = await Bun.file(path).text()
  await expect(initProject(path, root)).rejects.toThrow('never overwrites')
  expect(await Bun.file(path).text()).toBe(before)
  expect(await Bun.file(join(root, 'node_modules')).exists()).toBe(false)
})

test('unrecognized stacks require explicit verification instead of inventing passing checks', async () => {
  const path = join(root, 'agents.yaml')
  await initProject(path, root)
  const config = await loadCompanyConfig(path)
  expect(validateCompanyConfig(config)).toContain('project.verification must be a nonempty array of commands')
})

test('doctor reports missing credentials and checks without launching agents', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const diagnostics = await doctorProject({ ...config, project: { ...config.project, root: undefined, verification: undefined } }, 'linear', {})
  expect(diagnostics.find(d => d.name === 'Verification')?.ok).toBe(false)
  expect(diagnostics.find(d => d.name === 'GitHub')?.detail).toContain('GITHUB_TOKEN')
  expect(diagnostics.find(d => d.name === 'Task source')?.detail).toContain('LINEAR_API_KEY')
})

test('doctor knows the cursor provider', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const agents = config.agents.map(a => (a.capabilities.includes('write_code') ? { ...a, llm: { ...a.llm, provider: 'cursor', model: 'cursor-grok-4.6-high' } } : a))
  const diagnostics = await doctorProject({ ...config, agents, project: { ...config.project, root: undefined } }, 'linear', {})
  const cursor = diagnostics.find(d => d.name === 'Provider: cursor')
  expect(cursor).toBeDefined()
  // Present or missing depends on the machine; "unsupported" never does.
  expect(cursor!.detail).not.toContain('Unsupported provider')
  expect(cursor!.ok).toBe(Boolean(Bun.which('cursor-agent')))
})

test('doctor reports whether agent runs can be sandboxed', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const project = { ...config.project, root: undefined }
  const off = await doctorProject({ ...config, project }, 'linear', { FLOOR_AGENTS_SANDBOX: 'off' })
  expect(off.find(d => d.name === 'Sandbox')).toMatchObject({ ok: true })
  expect(off.find(d => d.name === 'Sandbox')?.detail).toContain('uncontained')
  const on = await doctorProject({ ...config, project }, 'linear', {})
  expect(on.find(d => d.name === 'Sandbox')?.ok).toBe(process.platform === 'darwin' && Boolean(Bun.which('sandbox-exec')))
})

test('doctor still requires verification when implementers share a manifest with voters', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const voter = { ...config.agents[0]!, id: 'reviewer', capabilities: ['review_rfc', 'vote'] as const, external: true }
  const mixed = { ...config, agents: [...config.agents, voter], project: { ...config.project, root: undefined, verification: undefined } }
  const diagnostics = await doctorProject(mixed, 'linear', {})
  expect(diagnostics.find(d => d.name === 'Verification')?.ok).toBe(false)
})

test('doctor skips verification for a committee-only manifest', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const voters = config.agents.map(a => ({ ...a, capabilities: ['review_rfc', 'vote'] as const }))
  const diagnostics = await doctorProject({ ...config, agents: voters, project: { ...config.project, root: undefined, verification: undefined } }, 'linear', {})
  expect(diagnostics.find(d => d.name === 'Verification')).toBeUndefined()
})

test('rejects invalid commands and missing issue arguments before startup', () => {
  expect(parseArgs(['run', '--issue', '123', '--config', '/tmp/project.yaml'])).toEqual({ command: 'run', issue: '123', config: '/tmp/project.yaml' })
  expect(() => parseArgs(['run'])).toThrow('Usage:')
  expect(() => parseArgs(['run', '--issue'])).toThrow('requires a value')
  expect(() => parseArgs(['run', '--issue', '123', '--typo'])).toThrow('Unknown argument')
  expect(() => parseArgs(['doctor', '--issue', '123'])).toThrow('only supported with run')
})

test('remote identity parsing supports SSH and HTTPS but rejects lookalike hosts', () => {
  for (const url of ['git@github.com:example/target.git', 'https://github.com/example/target.git', 'ssh://git@github.com/example/target.git']) {
    expect(githubRemote(url)).toEqual({ owner: 'example', repo: 'target' })
  }
  expect(githubRemote('https://github.com.evil.test/example/target')).toBeNull()
})
