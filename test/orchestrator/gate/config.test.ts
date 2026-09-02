import { test, expect } from 'bun:test'
import { loadGateConfig } from '@floor-agents/orchestrator'

test('loads the shipped example config', async () => {
  const config = await loadGateConfig('config/gate/gate.example.yaml', {})

  expect(config.repos).toEqual(['your-repo'])
  expect(config.pollIntervalMs).toBe(60000)
  expect(config.promptTemplatePath).toBe('config/gate/review-prompt.md')
  expect(config.mergeEnabled).toBe(false)
  expect(config.gate.authLabels).toEqual(['auth'])
  expect(config.gate.needsHumanLabel).toBe('needs-human')
  expect(config.excludeAuthors).toEqual(['your-bot-account'])
  expect(config.gate.trustedReviewers).toEqual({ 'your-bot-account': 'codex' })
  expect(config.vendor.branchPrefixes).toEqual([{ prefix: 'cursor/', vendor: 'cursor' }])
  expect(config.vendor.bodyMarkers).toEqual([{ prefix: 'Generated-By:', vendor: 'some-agent' }])
})

test('GATE_MERGE_ENABLED env var overrides the file default', async () => {
  const config = await loadGateConfig('config/gate/gate.example.yaml', { GATE_MERGE_ENABLED: 'true' })
  expect(config.mergeEnabled).toBe(true)
})

test('throws a clear error when the config file does not exist', async () => {
  await expect(loadGateConfig('config/gate/does-not-exist.yaml', {})).rejects.toThrow('not found')
})

test('trustedReviewers keys are lowercased on load, regardless of file casing', async () => {
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const dir = './data/test-gate-config-case'
  await mkdir(dir, { recursive: true })
  const path = `${dir}/gate.yaml`
  try {
    await writeFile(path, 'repos: [r]\ngate:\n  trustedReviewers:\n    Some-Bot: Codex\n')
    const config = await loadGateConfig(path, {})
    expect(config.gate.trustedReviewers).toEqual({ 'some-bot': 'Codex' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a gate config with no trustedReviewers at all defaults to empty (fail-closed)', async () => {
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const dir = './data/test-gate-config-notrust'
  await mkdir(dir, { recursive: true })
  const path = `${dir}/gate.yaml`
  try {
    await writeFile(path, 'repos: [r]\n')
    const config = await loadGateConfig(path, {})
    expect(config.gate.trustedReviewers).toEqual({})
    expect(config.excludeAuthors).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('trustedReviewers accepts an array value for a login trusted for multiple vendors, lowercasing the login but not the vendor names', async () => {
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const dir = './data/test-gate-config-multivendor'
  await mkdir(dir, { recursive: true })
  const path = `${dir}/gate.yaml`
  try {
    await writeFile(
      path,
      'repos: [r]\ngate:\n  trustedReviewers:\n    Gate-Bot:\n      - Codex\n      - Gemini\n    solo-bot: codex\n',
    )
    const config = await loadGateConfig(path, {})
    expect(config.gate.trustedReviewers).toEqual({
      'gate-bot': ['Codex', 'Gemini'],
      'solo-bot': 'codex',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a "__proto__" login key in trustedReviewers does not pollute the parsed object\'s prototype', async () => {
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const dir = './data/test-gate-config-proto-pollution'
  await mkdir(dir, { recursive: true })
  const path = `${dir}/gate.yaml`
  try {
    // A malicious (or just malformed) config entry keyed "__proto__",
    // mapped to an array. On a plain `{}`-based accumulator, assigning to
    // the "__proto__" key changes the OBJECT'S PROTOTYPE rather than
    // creating an own property — every other property lookup on that
    // object (e.g. resolving an unrelated, never-configured login) would
    // then inherit from that array. Object.create(null) closes this.
    await writeFile(path, 'repos: [r]\ngate:\n  trustedReviewers:\n    __proto__:\n      - codex\n    real-bot: gemini\n')
    const config = await loadGateConfig(path, {})

    // The "__proto__" entry became an ordinary own property (or was
    // otherwise inert) — it must NOT have changed the object's actual
    // prototype, which would make some unrelated key resolve through it.
    expect(Object.getPrototypeOf(config.gate.trustedReviewers)).not.toEqual(['codex'])
    expect(config.gate.trustedReviewers['some-unconfigured-login']).toBeUndefined()
    expect(config.gate.trustedReviewers['real-bot']).toBe('gemini')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('gate.secondReviewer is parsed as a plain string, and is undefined when unset', async () => {
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const dir = './data/test-gate-config-second-reviewer'
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(`${dir}/with.yaml`, 'repos: [r]\ngate:\n  secondReviewer: gemini\n')
    const withIt = await loadGateConfig(`${dir}/with.yaml`, {})
    expect(withIt.gate.secondReviewer).toBe('gemini')

    await writeFile(`${dir}/without.yaml`, 'repos: [r]\ngate:\n  authLabels: [auth]\n')
    const withoutIt = await loadGateConfig(`${dir}/without.yaml`, {})
    expect(withoutIt.gate.secondReviewer).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
