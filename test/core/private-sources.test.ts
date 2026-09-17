import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCompanyConfig, validateCompanyConfig, privateSourceDenials, trustedWithPrivateSources, type PrivateSourcePolicy } from '@floor-agents/core'

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'floor-sources-'))
  await mkdir(join(dir, '.agents'))
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const write = async (yaml: string): Promise<string> => {
  const path = join(dir, '.agents', `${crypto.randomUUID()}.yaml`)
  await Bun.write(path, yaml)
  return path
}

const manifest = (sources: string, guardrails = '') => `
name: t
project: { name: t, repo: t }
agents:
  - { id: dev, name: Dev, promptTemplate: dev.md, llm: { provider: claude-code, model: opus }, capabilities: [write_code] }
sources:
${sources}
guardrails:
  maxFilesPerTask: 20
${guardrails}
`

describe('sources in the manifest', () => {
  test('paths resolve against the manifest, and an unmarked source is private', async () => {
    const config = await loadCompanyConfig(await write(manifest(`
  findings: { path: ../../docs/findings.html, format: html, visibility: private }
  notes: { path: notes.md }
  readme: { path: ../README.md, visibility: public }`)))
    expect(config.sources?.findings).toEqual({ path: join(dir, '..', 'docs', 'findings.html'), format: 'html', visibility: 'private' })
    expect(config.sources?.notes).toEqual({ path: join(dir, '.agents', 'notes.md'), visibility: 'private' })
    expect(config.sources?.readme?.visibility).toBe('public')
  })

  test('the trusted provider list is read from guardrails', async () => {
    const config = await loadCompanyConfig(await write(manifest('  a: { path: a.md }', '  privateSourceProviders: [claude-code, cursor]')))
    expect(config.guardrails.privateSourceProviders).toEqual(['claude-code', 'cursor'])
    expect(validateCompanyConfig(config)).toEqual([])
  })

  test('a source without a path or with an unknown visibility is invalid', async () => {
    const config = await loadCompanyConfig(await write(manifest(`
  a: { format: html }
  b: { path: b.md, visibility: internal }`, '  privateSourceProviders: [claude-code, 3]')))
    const errors = validateCompanyConfig(config)
    expect(errors).toContain('sources.a.path is required')
    expect(errors).toContain('sources.b.visibility must be public or private')
    expect(errors).toContain('guardrails.privateSourceProviders must be a list of provider names')
  })
})

describe('privateSourceDenials', () => {
  const config = {
    guardrails: { privateSourceProviders: ['claude-code', 'cursor'] },
    sources: {
      findings: { path: '/docs/findings.html', visibility: 'private' as const },
      narrative: { path: '/docs/vlist.md', visibility: 'private' as const },
      readme: { path: '/repo/README.md', visibility: 'public' as const },
    },
  } satisfies PrivateSourcePolicy

  test('a trusted provider is denied nothing', () => {
    expect(trustedWithPrivateSources(config, 'cursor')).toBe(true)
    expect(privateSourceDenials(config, 'cursor')).toEqual([])
  })

  test('any other provider is denied every private source, and no public one', () => {
    expect(trustedWithPrivateSources(config, 'codex-cli')).toBe(false)
    expect(privateSourceDenials(config, 'codex-cli')).toEqual(['/docs/findings.html', '/docs/vlist.md'])
  })

  test('without a trusted list, no provider may read private sources', () => {
    const untrusted = { ...config, guardrails: {} }
    expect(privateSourceDenials(untrusted, 'claude-code')).toEqual(['/docs/findings.html', '/docs/vlist.md'])
  })

  test('a manifest without sources denies nothing', () => {
    expect(privateSourceDenials({ guardrails: {} }, 'codex-cli')).toEqual([])
  })
})
