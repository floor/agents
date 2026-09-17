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
