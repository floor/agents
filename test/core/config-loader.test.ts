import { test, expect } from 'bun:test'
import { loadCompanyConfig } from '@floor-agents/core'

test('loads default template', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')

  expect(config.name).toBe('Default Team')
  expect(config.agents.length).toBe(5)
  expect(config.agents.map(a => a.id)).toEqual(['backend', 'frontend', 'pm', 'cto', 'qa'])
  expect(config.workflow.states.length).toBe(8)
  expect(config.chain.nodes.length).toBe(5)
  expect(config.guardrails.maxFilesPerTask).toBe(20)
  expect(config.costs.maxCostPerTask).toBe(5.0)
  expect(config.project.fixTurns).toBe(1)
})

test('throws on missing config file', async () => {
  await expect(loadCompanyConfig('nonexistent.yaml')).rejects.toThrow('Config file not found')
})

test('parses agent definitions correctly', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const backend = config.agents.find(a => a.id === 'backend')!

  expect(backend.name).toBe('Backend Developer')
  expect(backend.llm.provider).toBe('claude-code')
  expect(backend.llm.model).toBe('sonnet')
  expect(backend.llm.temperature).toBe(0.2)
  expect(backend.llm.maxTokens).toBe(16000)
  expect(backend.capabilities).toContain('write_code')
  expect(backend.autonomy).toBe('T1')
})

test('config paths resolve against the manifest instead of launch directory', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  expect(config.project.root).toBe(process.cwd())
  expect(config.agents[0]?.promptTemplate).toBe(`${process.cwd()}/agents/backend-dev.md`)
})

test('a project may declare where its tasks live', async () => {
  const dir = await (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'floor-tasks-'))
  const { join } = await import('node:path')
  const path = join(dir, 'agents.yaml')
  await Bun.write(path, `
name: t
project: { name: t, repo: t }
agents:
  - { id: dev, name: Dev, promptTemplate: dev.md, llm: { provider: cursor, model: m }, capabilities: [write_code] }
tasks:
  source: linear
  labels: [agent, floor]
  linear: { team: FLO, project: vlist }
`)
  const config = await loadCompanyConfig(path)
  expect(config.tasks).toEqual({ source: 'linear', labels: ['agent', 'floor'], linear: { team: 'FLO', project: 'vlist' } })
  const { validateCompanyConfig } = await import('@floor-agents/core')
  expect(validateCompanyConfig(config)).toEqual([])
  await Bun.write(path, `
name: t
project: { name: t, repo: t }
agents:
  - { id: dev, name: Dev, promptTemplate: dev.md, llm: { provider: cursor, model: m }, capabilities: [write_code] }
tasks: { source: linear }
`)
  expect(validateCompanyConfig(await loadCompanyConfig(path))).toContain('tasks.linear.team is required when tasks.source is linear')
  await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
})

test('a project may send implementer PRs to the committee', async () => {
  const dir = await (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'floor-review-'))
  const { join } = await import('node:path')
  const path = join(dir, 'agents.yaml')
  await Bun.write(path, `
name: t
project: { name: t, repo: t }
agents:
  - { id: dev, name: Dev, promptTemplate: dev.md, llm: { provider: cursor, model: m }, capabilities: [write_code] }
  - { id: claude, name: Claude, promptTemplate: c.md, llm: { provider: anthropic, model: m }, capabilities: [vote] }
review:
  committee: true
`)
  const config = await loadCompanyConfig(path)
  expect(config.review).toEqual({ committee: true })
  const { validateCompanyConfig } = await import('@floor-agents/core')
  expect(validateCompanyConfig(config)).toEqual([])
  await Bun.write(path, `
name: t
project: { name: t, repo: t }
agents:
  - { id: dev, name: Dev, promptTemplate: dev.md, llm: { provider: cursor, model: m }, capabilities: [write_code] }
review:
  committee: true
`)
  expect(validateCompanyConfig(await loadCompanyConfig(path))).toContain('review.committee is true but no agent has the vote capability')
  await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
})

test('an external agent may opt into voting by comment', async () => {
  const dir = await (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'floor-vote-comment-'))
  const { join } = await import('node:path')
  const path = join(dir, 'agents.yaml')
  await Bun.write(path, `
name: t
project: { name: t, repo: t }
agents:
  - { id: codex, name: Codex, promptTemplate: c.md, llm: { provider: codex-cli, model: m }, capabilities: [vote], external: true, voteByComment: true }
`)
  const config = await loadCompanyConfig(path)
  expect(config.agents[0]?.voteByComment).toBe(true)
  await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
})

test('parses project.fixTurns and verification flaky flags', async () => {
  const dir = await (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'floor-fix-turns-'))
  const { join } = await import('node:path')
  const path = join(dir, 'agents.yaml')
  await Bun.write(path, `
name: t
project:
  name: t
  repo: t
  fixTurns: 0
  verification:
    - { name: Tests, command: [bun, test], flaky: true }
agents:
  - { id: dev, name: Dev, promptTemplate: dev.md, llm: { provider: cursor, model: m }, capabilities: [write_code] }
`)
  const config = await loadCompanyConfig(path)
  expect(config.project.fixTurns).toBe(0)
  expect(config.project.verification).toEqual([{ name: 'Tests', command: ['bun', 'test'], flaky: true }])
  const { validateCompanyConfig } = await import('@floor-agents/core')
  expect(validateCompanyConfig(config)).toEqual([])
  await Bun.write(path, `
name: t
project:
  name: t
  repo: t
  verification:
    - null
    - { name: Tests }
agents:
  - { id: dev, name: Dev, promptTemplate: dev.md, llm: { provider: cursor, model: m }, capabilities: [write_code] }
`)
  const malformed = await loadCompanyConfig(path)
  const errors = validateCompanyConfig(malformed)
  expect(errors.filter(e => e.includes('entries need a name and a nonempty command argument array')).length).toBeGreaterThanOrEqual(2)
  await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
})
