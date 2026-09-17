import { test, expect, describe } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxProfile, sandboxed, reviewerSandbox, implementerSandbox, projectCommandSandbox, withDenyRead, denyReadEnv } from '@floor-agents/sandbox'

const HOME = '/Users/someone'

describe('sandboxProfile', () => {
  test('denies writes under home, then allows only what the run needs', () => {
    const profile = sandboxProfile(implementerSandbox('cursor', ['/Users/someone/repo/.agents/worktrees/x'], {}, HOME))
    const deny = profile.indexOf('(deny file-write* (subpath "/Users/someone"))')
    const allow = profile.indexOf('(allow file-write* (subpath "/Users/someone/repo/.agents/worktrees/x"))')
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
    const profile = sandboxProfile(projectCommandSandbox(['/Users/someone/repo/.agents/worktrees/x'], {}, HOME))
    expect(profile).toContain('(allow file-write* (subpath "/Users/someone/repo/.agents/worktrees/x"))')
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

  test('private sources join the read denials, after every write allowance', () => {
    const spec = withDenyRead(implementerSandbox('cursor', ['/Users/someone/repo'], {}, HOME), ['/Users/someone/docs/findings.html'])
    const lines = sandboxProfile(spec).split('\n')
    const denial = lines.indexOf('(deny file-read* (subpath "/Users/someone/docs/findings.html"))')
    expect(denial).toBeGreaterThan(-1)
    expect(denial).toBeGreaterThan(Math.max(...lines.map((l, i) => (l.startsWith('(allow') ? i : -1))))
    // The credential denials are kept, not replaced.
    expect(spec.denyRead).toContain('/Users/someone/.ssh')
    expect(withDenyRead(spec, [])).toBe(spec)
  })

  test('Codex may write its own state and nothing else under home', () => {
    const profile = sandboxProfile(reviewerSandbox('codex', {}, HOME))
    expect(profile).toContain('(allow file-write* (subpath "/Users/someone/.codex"))')
    expect(profile).not.toContain('.cursor')
  })

  test('a child sandbox receives the denials through FLOOR_AGENTS_DENY_READ, merged with any set', () => {
    expect(denyReadEnv(['/docs/a.html', '/docs/b.md'], {})).toBe('/docs/a.html,/docs/b.md')
    expect(denyReadEnv(['/docs/a.html'], { FLOOR_AGENTS_DENY_READ: '~/private' })).toBe('~/private,/docs/a.html')
    expect(denyReadEnv([], {})).toBeUndefined()
    // Split on the comma, this path would deny two paths that do not exist.
    expect(() => denyReadEnv(['/docs/a,b.html'], {})).toThrow(/comma/)
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

  test('a denied private source cannot be read, while the repository beside it can', async () => {
    const home = await mkdtemp(join(tmpdir(), 'floor-sandbox-private-'))
    try {
      const repo = join(home, 'repo')
      const docs = join(home, 'docs')
      await mkdir(repo)
      await mkdir(docs)
      await Bun.write(join(repo, 'README.md'), 'PUBLIC_TEXT')
      await Bun.write(join(docs, 'findings.html'), 'PRIVATE_TEXT')
      const spec = withDenyRead(reviewerSandbox('codex', {}, home), [join(docs, 'findings.html')])
      const script = `cat ${JSON.stringify(join(repo, 'README.md'))}; cat ${JSON.stringify(join(docs, 'findings.html'))}`
      const proc = Bun.spawn(sandboxed(['sh', '-c', script], spec, { env: {} }), { stdout: 'pipe', stderr: 'pipe' })
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      expect(out).toContain('PUBLIC_TEXT')
      expect(out).not.toContain('PRIVATE_TEXT')
      expect(err).toContain('Operation not permitted')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
