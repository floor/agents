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
