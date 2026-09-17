import { test, expect, describe } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxProfile, sandboxed, reviewerSandbox, implementerSandbox, projectCommandSandbox } from '@floor-agents/sandbox'

const HOME = '/Users/someone'

describe('sandboxProfile', () => {
  test('denies writes under home, then allows only what the run needs', () => {
    const profile = sandboxProfile(implementerSandbox('cursor', ['/Users/someone/repo/.worktrees/x'], {}, HOME))
    const deny = profile.indexOf('(deny file-write* (subpath "/Users/someone"))')
    const allow = profile.indexOf('(allow file-write* (subpath "/Users/someone/repo/.worktrees/x"))')
    expect(deny).toBeGreaterThan(-1)
    // Last match wins, so an allowance must come after the broad denial.
    expect(allow).toBeGreaterThan(deny)
    expect(profile).toContain('(subpath "/Users/someone/.cursor")')
  })

  test('a reviewer gets no writable repository at all', () => {
    const profile = sandboxProfile(reviewerSandbox('claude', {}, HOME))
    // Regex rules escape their dots, so compare with the escapes removed.
    const allows = profile.split('\n').filter(l => l.startsWith('(allow file-write*')).map(l => l.replace(/\\/g, ''))
    expect(allows.length).toBeGreaterThan(0)
    expect(allows.every(l => l.includes('/Users/someone/.claude') || l.includes('/Users/someone/Library/Caches'))).toBe(true)
  })

  test('credential stores and .env files are unreadable, and nothing reopens them', () => {
    const profile = sandboxProfile(reviewerSandbox('cursor', {}, HOME))
    expect(profile).toContain('(deny file-read* (subpath "/Users/someone/.ssh"))')
    expect(profile).toContain('(deny file-read* (subpath "/Users/someone/.config/gh"))')
    expect(profile).toContain('(deny file-read* (regex #"/\\\\.env(\\\\.[^/]*)?$"))')
    const lines = profile.split('\n')
    const lastAllow = Math.max(...lines.map((l, i) => (l.startsWith('(allow file-write*') ? i : -1)))
    const firstReadDeny = lines.findIndex(l => l.startsWith('(deny file-read*'))
    expect(firstReadDeny).toBeGreaterThan(lastAllow)
  })

  test('FLOOR_AGENTS_DENY_READ adds unreadable paths, expanding ~', () => {
    const profile = sandboxProfile(reviewerSandbox('cursor', { FLOOR_AGENTS_DENY_READ: '~/Code/private, /srv/secrets' }, HOME))
    expect(profile).toContain('(deny file-read* (subpath "/Users/someone/Code/private"))')
    expect(profile).toContain('(deny file-read* (subpath "/srv/secrets"))')
  })

  test('paths are resolved, so a symlinked temp folder is still contained', async () => {
    // On macOS tmpdir() is /var/folders/…, a symlink into /private. A rule on the
    // unresolved path never matched, and the enforcement test below wrote freely.
    const dir = await mkdtemp(join(tmpdir(), 'floor-sandbox-real-'))
    try {
      const spec = implementerSandbox('cursor', [dir], {}, dir)
      const { realpathSync } = await import('node:fs')
      expect(spec.home).toBe(realpathSync(dir))
      expect(spec.writable[0]).toBe(realpathSync(dir))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('project commands may write the checkout and package caches, not the rest of home', () => {
    const profile = sandboxProfile(projectCommandSandbox(['/Users/someone/repo/.worktrees/x'], {}, HOME))
    expect(profile).toContain('(allow file-write* (subpath "/Users/someone/repo/.worktrees/x"))')
    expect(profile).toContain('(allow file-write* (subpath "/Users/someone/.bun"))')
    expect(profile).toContain('(allow file-write* (subpath "/Users/someone/.npm"))')
    expect(profile).not.toContain('(subpath "/Users/someone/.cursor")')
  })

  test('FLOOR_AGENTS_SANDBOX_WRITABLE adds writable paths for implementers and project commands', () => {
    const env = { FLOOR_AGENTS_SANDBOX_WRITABLE: '~/.gradle' }
    expect(sandboxProfile(implementerSandbox('claude', [], env, HOME))).toContain('(allow file-write* (subpath "/Users/someone/.gradle"))')
    expect(sandboxProfile(projectCommandSandbox([], env, HOME))).toContain('(allow file-write* (subpath "/Users/someone/.gradle"))')
    // A reviewer never gains writable paths from the environment.
    expect(sandboxProfile(reviewerSandbox('claude', env, HOME))).not.toContain('.gradle')
  })

  test('quotes in a path cannot break out of the profile string', () => {
    const profile = sandboxProfile(implementerSandbox('cursor', ['/tmp/a"b'], {}, HOME))
    expect(profile).toContain('(subpath "/tmp/a\\"b")')
  })
})

describe('sandboxed', () => {
  const spec = reviewerSandbox('cursor', {}, HOME)

  test('wraps the command in sandbox-exec on macOS', () => {
    const argv = sandboxed(['cursor-agent', '-p', 'hi'], spec, { env: {}, platform: 'darwin', which: () => '/usr/bin/sandbox-exec' })
    expect(argv.slice(0, 2)).toEqual(['sandbox-exec', '-p'])
    expect(argv.slice(3)).toEqual(['cursor-agent', '-p', 'hi'])
  })

  test('refuses to run uncontained where sandbox-exec is unavailable', () => {
    expect(() => sandboxed(['cursor-agent'], spec, { env: {}, platform: 'linux', which: () => null }))
      .toThrow(/Refusing to run cursor-agent without a sandbox/)
  })

  test('FLOOR_AGENTS_SANDBOX=off is the only way to run uncontained', () => {
    expect(sandboxed(['cursor-agent'], spec, { env: { FLOOR_AGENTS_SANDBOX: 'off' }, platform: 'linux', which: () => null }))
      .toEqual(['cursor-agent'])
  })
})

// The profile's actual effect, enforced by the operating system. It uses a
// temporary directory as "home", so nothing outside it is ever written.
describe.skipIf(process.platform !== 'darwin' || !Bun.which('sandbox-exec'))('sandbox-exec enforcement', () => {
  test('writes outside the allowed folder fail; writes inside succeed; denied reads fail', async () => {
    const home = await mkdtemp(join(tmpdir(), 'floor-sandbox-'))
    try {
      const work = join(home, 'work')
      const secret = join(home, '.ssh')
      await mkdir(work)
      await mkdir(secret)
      await Bun.write(join(secret, 'id'), 'private')
      const spec = implementerSandbox('cursor', [work], {}, home)
      const script = [
        `echo x > ${JSON.stringify(join(home, 'outside.txt'))} && echo OUTSIDE_WRITTEN`,
        `echo x > ${JSON.stringify(join(work, 'inside.txt'))} && echo INSIDE_WRITTEN`,
        `cat ${JSON.stringify(join(secret, 'id'))} && echo SECRET_READ`,
      ].join('; ')
      const proc = Bun.spawn(sandboxed(['sh', '-c', script], spec, { env: {} }), { stdout: 'pipe', stderr: 'pipe' })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      expect(out).toContain('INSIDE_WRITTEN')
      expect(out).not.toContain('OUTSIDE_WRITTEN')
      expect(out).not.toContain('SECRET_READ')
      expect(await Bun.file(join(home, 'outside.txt')).exists()).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
