import { test, expect } from 'bun:test'
import { loadGateConfig } from '@floor-agents/orchestrator'

test('loads the shipped example config', async () => {
  const config = await loadGateConfig('config/gate/gate.example.yaml', {})

  expect(config.repos).toEqual(['radiooooo'])
  expect(config.pollIntervalMs).toBe(60000)
  expect(config.promptTemplatePath).toBe('config/gate/review-prompt.md')
  expect(config.mergeEnabled).toBe(false)
  expect(config.gate.authLabels).toEqual(['auth'])
  expect(config.gate.needsHumanLabel).toBe('needs-human')
  expect(config.vendor.branchPrefixes).toEqual([{ prefix: 'cursor/', vendor: 'grok' }])
  expect(config.vendor.bodyMarkers).toEqual([{ prefix: 'Claude-Session:', vendor: 'claude' }])
})

test('GATE_MERGE_ENABLED env var overrides the file default', async () => {
  const config = await loadGateConfig('config/gate/gate.example.yaml', { GATE_MERGE_ENABLED: 'true' })
  expect(config.mergeEnabled).toBe(true)
})

test('throws a clear error when the config file does not exist', async () => {
  await expect(loadGateConfig('config/gate/does-not-exist.yaml', {})).rejects.toThrow('not found')
})
