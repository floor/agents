import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCompanyConfig, validateCompanyConfig, DEFAULT_DECISIONS } from '@floor-agents/core'

let dir = ''
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'floor-decisions-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const HEAD = `
name: t
project: { name: t, repo: t }
agents:
  - { id: dev, name: Dev, promptTemplate: dev.md, llm: { provider: cursor, model: m }, capabilities: [write_code] }
  - { id: claude, name: Claude, promptTemplate: c.md, llm: { provider: anthropic, model: m }, capabilities: [vote] }
  - { id: codex, name: Codex, promptTemplate: x.md, llm: { provider: codex-cli, model: m }, capabilities: [vote] }
`

let n = 0
async function load(tail: string) {
  const path = join(dir, `agents-${n++}.yaml`)
  await Bun.write(path, HEAD + tail)
  return loadCompanyConfig(path)
}

async function errorsFor(tail: string): Promise<readonly string[]> {
  return validateCompanyConfig(await load(tail))
}

describe('loading', () => {
  test('without a decisions block, today\'s rules apply', async () => {
    const config = await load('')
    expect(config.decisions).toEqual(DEFAULT_DECISIONS)
    expect(config.decisions?.['pr-review']).toEqual({ mode: 'veto', quorum: 2, rounds: 3 })
    expect(config.decisions?.['rfc']).toEqual({ mode: 'majority', quorum: 1 })
    expect(config.roles).toBeUndefined()
    expect(config.humans).toBeUndefined()
    expect(validateCompanyConfig(config)).toEqual([])
  })

  test('the default template still validates', async () => {
    const config = await loadCompanyConfig('config/templates/default.yaml')
    expect(config.decisions).toEqual(DEFAULT_DECISIONS)
    expect(validateCompanyConfig(config)).toEqual([])
  })

  test('a kind the manifest does not name keeps its default', async () => {
    const config = await load(`
decisions:
  pr-review: { mode: unanimous }
`)
    expect(config.decisions?.['pr-review']).toEqual({ mode: 'unanimous' })
    expect(config.decisions?.['rfc']).toEqual(DEFAULT_DECISIONS['rfc']!)
  })

  test('a full example parses and validates', async () => {
    const config = await load(`
roles:
  lead: claude
  implementers: [dev]
  reviewers: [claude, codex]
humans:
  jvial: { can: [assign-lead, override, publish] }
  guest: { can: [override] }
decisions:
  pr-review: { mode: lead-with-advisors, rounds: 2, timeoutMs: 600000, voters: [codex] }
  rfc: { mode: veto, quorum: 2 }
  merge: { mode: lead }
  publish: { mode: human, humans: [jvial] }
  gate-failure: { mode: majority, quorum: 1 }
  lead-assignment: { mode: human, humans: [jvial] }
`)
    expect(config.roles).toEqual({ lead: 'claude', implementers: ['dev'], reviewers: ['claude', 'codex'] })
    expect(config.humans).toEqual({ jvial: { can: ['assign-lead', 'override', 'publish'] }, guest: { can: ['override'] } })
    expect(config.decisions).toEqual({
      'pr-review': { mode: 'lead-with-advisors', rounds: 2, timeoutMs: 600000, voters: ['codex'] },
      'rfc': { mode: 'veto', quorum: 2 },
      'merge': { mode: 'lead' },
      'publish': { mode: 'human', humans: ['jvial'] },
      'gate-failure': { mode: 'majority', quorum: 1 },
      'lead-assignment': { mode: 'human', humans: ['jvial'] },
    })
    expect(validateCompanyConfig(config)).toEqual([])
  })
})

describe('validation', () => {
  test('an unknown mode', async () => {
    expect(await errorsFor(`
decisions:
  pr-review: { mode: coin-flip }
`)).toContain('decisions.pr-review.mode must be one of lead, lead-with-advisors, majority, unanimous, veto, human (got "coin-flip")')
  })

  test('a policy without a mode', async () => {
    expect((await errorsFor(`
decisions:
  merge: { quorum: 2 }
`)).some(e => e.startsWith('decisions.merge.mode must be one of'))).toBe(true)
  })

  test('no agent may assign the lead', async () => {
    for (const mode of ['lead', 'majority', 'veto', 'unanimous']) {
      const errors = await errorsFor(`
roles: { lead: claude }
decisions:
  lead-assignment: { mode: ${mode} }
`)
      expect(errors).toContain(`decisions.lead-assignment.mode must be human: no agent may assign the lead (got "${mode}")`)
    }
    expect(await errorsFor(`
decisions:
  lead-assignment: { mode: human }
`)).toEqual([])
  })

  test('lead modes need roles.lead', async () => {
    expect(await errorsFor(`
decisions:
  merge: { mode: lead }
  pr-review: { mode: lead-with-advisors }
`)).toEqual([
      'decisions.pr-review.mode is lead-with-advisors but roles.lead is not set',
      'decisions.merge.mode is lead but roles.lead is not set',
    ])
  })

  test('roles name agents that exist', async () => {
    expect(await errorsFor(`
roles:
  lead: ghost
  implementers: [dev, phantom]
  reviewers: [codex, spook]
`)).toEqual([
      'roles.lead references unknown agent: "ghost"',
      'roles.implementers references unknown agent: "phantom"',
      'roles.reviewers references unknown agent: "spook"',
    ])
  })

  test('roles lists are lists', async () => {
    expect(await errorsFor(`
roles: { reviewers: codex }
`)).toContain('roles.reviewers must be a list of agent ids')
  })

  test('a human policy names people from the humans block', async () => {
    expect(await errorsFor(`
humans:
  jvial: { can: [publish] }
decisions:
  publish: { mode: human, humans: [jvial, stranger] }
`)).toEqual(['decisions.publish.humans references unknown human: "stranger" (declare it under humans)'])
    expect(await errorsFor(`
decisions:
  publish: { mode: human, humans: [jvial] }
`)).toEqual(['decisions.publish.humans references unknown human: "jvial" (declare it under humans)'])
  })

  test('a human may only hold known permissions', async () => {
    expect(await errorsFor(`
humans:
  jvial: { can: [publish, merge-anything] }
`)).toEqual(['humans.jvial.can must list only assign-lead, override, publish'])
  })

  test('quorum is at least 1', async () => {
    for (const quorum of ['0', '-1', '1.5']) {
      expect(await errorsFor(`
decisions:
  rfc: { mode: majority, quorum: ${quorum} }
`)).toContain('decisions.rfc.quorum must be a whole number of at least 1')
    }
  })

  test('rounds and timeoutMs are positive', async () => {
    expect(await errorsFor(`
decisions:
  pr-review: { mode: veto, rounds: 0, timeoutMs: -5 }
`)).toEqual([
      'decisions.pr-review.rounds must be a whole number of at least 1',
      'decisions.pr-review.timeoutMs must be positive',
    ])
  })

  test('voters are agents', async () => {
    expect(await errorsFor(`
decisions:
  pr-review: { mode: veto, voters: [claude, ghost] }
`)).toEqual(['decisions.pr-review.voters references unknown agent: "ghost"'])
  })
})
