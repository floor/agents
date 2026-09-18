import { test, expect } from 'bun:test'
import { loadCompanyConfig, validateCompanyConfig } from '@floor-agents/core'

test('default template validates without errors', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const errors = validateCompanyConfig(config)
  expect(errors).toEqual([])
})

test('detects missing agent reference in chain', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const modified = {
    ...config,
    chain: {
      nodes: [
        ...config.chain.nodes,
        {
          agentId: 'ghost',
          receivesFrom: [],
          dispatchesTo: [],
          reportsTo: null,
          canApprove: false,
          canReject: false,
        },
      ],
    },
  }

  const errors = validateCompanyConfig(modified)
  expect(errors.some(e => e.includes('ghost'))).toBe(true)
})

test('detects invalid guardrails', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const modified = {
    ...config,
    guardrails: { ...config.guardrails, maxFilesPerTask: -1 },
  }

  const errors = validateCompanyConfig(modified)
  expect(errors.some(e => e.includes('maxFilesPerTask'))).toBe(true)
})

test('detects empty project name', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const modified = {
    ...config,
    project: { ...config.project, name: '' },
  }

  const errors = validateCompanyConfig(modified)
  expect(errors.some(e => e.includes('project.name'))).toBe(true)
})

test('detects empty project repo', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const modified = {
    ...config,
    project: { ...config.project, repo: '' },
  }

  const errors = validateCompanyConfig(modified)
  expect(errors.some(e => e.includes('project.repo'))).toBe(true)
})

test('detects cost warning exceeding max', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  const modified = {
    ...config,
    costs: { ...config.costs, warnCostThreshold: 100, maxCostPerTask: 5 },
  }

  const errors = validateCompanyConfig(modified)
  expect(errors.some(e => e.includes('warnCostThreshold'))).toBe(true)
})

test('rejects a negative fixTurns and a non-boolean flaky flag', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  expect(validateCompanyConfig({
    ...config,
    project: { ...config.project, fixTurns: -1 },
  }).some(e => e.includes('project.fixTurns'))).toBe(true)
  expect(validateCompanyConfig({
    ...config,
    project: {
      ...config.project,
      verification: [{ name: 'Tests', command: ['bun', 'test'], flaky: 'yes' as unknown as boolean }],
    },
  })).toContain('project.verification flaky must be a boolean')
})

test('malformed command entries are reported by the validator', async () => {
  const config = await loadCompanyConfig('config/templates/default.yaml')
  expect(validateCompanyConfig({
    ...config,
    project: { ...config.project, verification: [{ name: 'Tests' }] as unknown as typeof config.project.verification },
  }).some(e => e.includes('entries need a name and a nonempty command argument array'))).toBe(true)
  expect(validateCompanyConfig({
    ...config,
    project: { ...config.project, verification: [null] as unknown as typeof config.project.verification },
  }).some(e => e.includes('entries need a name and a nonempty command argument array'))).toBe(true)
})
