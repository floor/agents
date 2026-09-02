import { test, expect } from 'bun:test'
import { createGitHubAdapter, GitHubError } from '@floor-agents/github'

test('creates adapter', () => {
  const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
  expect(typeof adapter.createBranch).toBe('function')
  expect(typeof adapter.commitFiles).toBe('function')
})

test('rejects creating a branch named main', async () => {
  const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
  await expect(adapter.createBranch('repo', 'main')).rejects.toThrow('protected branch')
})

test('rejects creating a branch named master', async () => {
  const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
  await expect(adapter.createBranch('repo', 'master')).rejects.toThrow('protected branch')
})

test('rejects committing to main', async () => {
  const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
  await expect(
    adapter.commitFiles('repo', 'main', [{ path: 'test.ts', content: 'x' }], 'msg'),
  ).rejects.toThrow('protected branch')
})

test('allows agent branches', async () => {
  const adapter = createGitHubAdapter({ token: 'test', owner: 'test' })
  // This will fail with a network error (no real GitHub) but NOT with a protection error
  try {
    await adapter.createBranch('repo', 'agent/FLO-5-add-slugify')
  } catch (err) {
    expect((err as GitHubError).message).not.toContain('protected branch')
  }
})

// ── Review & gate mode additions ────────────────────────────────────────

function withMockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch
  // @ts-expect-error — test double, signature doesn't need to match lib.dom's fetch exactly
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)
  return () => { globalThis.fetch = original }
}

const rawPR = {
  number: 7,
  html_url: 'https://github.com/o/r/pull/7',
  title: 'Add feature',
  body: 'Description\n\nMore detail',
  head: { sha: 'deadbeef00112233445566778899aabbccddeeff', ref: 'feat/thing' },
  base: { ref: 'main' },
  user: { login: 'someone' },
  labels: [{ name: 'parity' }, { name: 'needs-human' }],
  draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
}

test('getPR maps GitHub PR shape to PRDetails', async () => {
  const restore = withMockFetch(url => {
    expect(url).toContain('/repos/o/r/pulls/7')
    return new Response(JSON.stringify(rawPR), { status: 200 })
  })
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    const pr = await adapter.getPR('r', '7')
    expect(pr).not.toBeNull()
    expect(pr!.id).toBe('7')
    expect(pr!.headSha).toBe('deadbeef00112233445566778899aabbccddeeff')
    expect(pr!.headRef).toBe('feat/thing')
    expect(pr!.baseRef).toBe('main')
    expect(pr!.authorLogin).toBe('someone')
    expect(pr!.labels).toEqual(['parity', 'needs-human'])
    expect(pr!.draft).toBe(false)
  } finally {
    restore()
  }
})

test('getPR returns null on 404', async () => {
  const restore = withMockFetch(() => new Response('not found', { status: 404 }))
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    expect(await adapter.getPR('r', '999')).toBeNull()
  } finally {
    restore()
  }
})

test('listOpenPRs paginates until a short page', async () => {
  let calls = 0
  const restore = withMockFetch(url => {
    calls++
    expect(url).toContain('state=open')
    const page = Number(new URL(url).searchParams.get('page'))
    const items = page === 1
      ? Array.from({ length: 100 }, (_, i) => ({ ...rawPR, number: i + 1 }))
      : [{ ...rawPR, number: 101 }]
    return new Response(JSON.stringify(items), { status: 200 })
  })
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    const prs = await adapter.listOpenPRs('r')
    expect(prs.length).toBe(101)
    expect(calls).toBe(2)
  } finally {
    restore()
  }
})

test('getCheckStatus: any failing check run wins', async () => {
  const restore = withMockFetch(url => {
    if (url.includes('/status')) {
      return new Response(JSON.stringify({ state: 'success', statuses: [{ state: 'success' }] }), { status: 200 })
    }
    return new Response(JSON.stringify({
      check_runs: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
      ],
    }), { status: 200 })
  })
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    expect(await adapter.getCheckStatus('r', 'sha')).toBe('failure')
  } finally {
    restore()
  }
})

test('getCheckStatus: all success is success', async () => {
  const restore = withMockFetch(url => {
    if (url.includes('/status')) {
      return new Response(JSON.stringify({ state: 'success', statuses: [{ state: 'success' }] }), { status: 200 })
    }
    return new Response(JSON.stringify({
      check_runs: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'neutral' },
      ],
    }), { status: 200 })
  })
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    expect(await adapter.getCheckStatus('r', 'sha')).toBe('success')
  } finally {
    restore()
  }
})

test('getCheckStatus: in-progress run is pending (not a pass)', async () => {
  const restore = withMockFetch(url => {
    if (url.includes('/status')) {
      return new Response(JSON.stringify({ state: 'pending', statuses: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({
      check_runs: [{ status: 'in_progress', conclusion: null }],
    }), { status: 200 })
  })
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    expect(await adapter.getCheckStatus('r', 'sha')).toBe('pending')
  } finally {
    restore()
  }
})

test('getCheckStatus: no checks at all is pending, never an implicit pass', async () => {
  const restore = withMockFetch(url => {
    if (url.includes('/status')) {
      return new Response(JSON.stringify({ state: 'pending', statuses: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ check_runs: [] }), { status: 200 })
  })
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    expect(await adapter.getCheckStatus('r', 'sha')).toBe('pending')
  } finally {
    restore()
  }
})

test('listComments maps author/body/createdAt', async () => {
  const restore = withMockFetch(() => new Response(JSON.stringify([
    { id: 1, user: { login: 'codex-bot' }, body: 'Verdict: approve as-is', created_at: '2026-02-01T00:00:00Z' },
  ]), { status: 200 }))
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    const comments = await adapter.listComments('r', '7')
    expect(comments).toEqual([
      { id: '1', author: 'codex-bot', body: 'Verdict: approve as-is', createdAt: new Date('2026-02-01T00:00:00Z') },
    ])
  } finally {
    restore()
  }
})

test('listComments paginates until a short page — a later verdict on page 2 is not missed', async () => {
  let calls = 0
  const restore = withMockFetch(url => {
    calls++
    expect(url).toContain('/issues/7/comments')
    const page = Number(new URL(url).searchParams.get('page'))
    const items = page === 1
      ? Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          user: { login: 'codex-bot' },
          body: 'Verdict: approve as-is',
          created_at: '2026-01-01T00:00:00Z',
        }))
      : [{ id: 101, user: { login: 'codex-bot' }, body: 'Verdict: changes needed', created_at: '2026-02-01T00:00:00Z' }]
    return new Response(JSON.stringify(items), { status: 200 })
  })
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    const comments = await adapter.listComments('r', '7')
    expect(comments.length).toBe(101)
    expect(comments[100]!.body).toBe('Verdict: changes needed')
    expect(calls).toBe(2)
  } finally {
    restore()
  }
})

test('addLabel posts the label', async () => {
  let sentBody: any = null
  const restore = withMockFetch((url, init) => {
    expect(url).toContain('/issues/7/labels')
    sentBody = JSON.parse(String(init?.body))
    return new Response('[]', { status: 200 })
  })
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    await adapter.addLabel('r', '7', 'needs-human')
    expect(sentBody).toEqual({ labels: ['needs-human'] })
  } finally {
    restore()
  }
})

test('removeLabel is idempotent when the label is already gone (404)', async () => {
  const restore = withMockFetch(() => new Response('not found', { status: 404 }))
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    await expect(adapter.removeLabel('r', '7', 'needs-human')).resolves.toBeUndefined()
  } finally {
    restore()
  }
})

test('getCommitDate reads the committer date', async () => {
  const restore = withMockFetch(() => new Response(JSON.stringify({
    commit: { committer: { date: '2026-03-01T00:00:00Z' }, author: { date: '2026-02-28T00:00:00Z' } },
  }), { status: 200 }))
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    const date = await adapter.getCommitDate('r', 'sha')
    expect(date).toEqual(new Date('2026-03-01T00:00:00Z'))
  } finally {
    restore()
  }
})

test('mergePR passes commit title/message through when provided', async () => {
  let sentBody: any = null
  const restore = withMockFetch((_url, init) => {
    sentBody = JSON.parse(String(init?.body))
    return new Response('{}', { status: 200 })
  })
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    await adapter.mergePR('r', '7', { commitTitle: 'Add feature (#7)', commitMessage: 'Description' })
    expect(sentBody).toEqual({ merge_method: 'squash', commit_title: 'Add feature (#7)', commit_message: 'Description' })
  } finally {
    restore()
  }
})

test('mergePR without options keeps prior behavior', async () => {
  let sentBody: any = null
  const restore = withMockFetch((_url, init) => {
    sentBody = JSON.parse(String(init?.body))
    return new Response('{}', { status: 200 })
  })
  try {
    const adapter = createGitHubAdapter({ token: 't', owner: 'o' })
    await adapter.mergePR('r', '7')
    expect(sentBody).toEqual({ merge_method: 'squash' })
  } finally {
    restore()
  }
})
