import type {
  GitAdapter,
  FileContent,
  FileEntry,
  Commit,
  PullRequest,
  FileWrite,
  PRDetails,
  PRCommentEntry,
  CheckStatus,
  MergeOptions,
} from '@floor-agents/core'

export type GitHubAdapterConfig = {
  readonly token: string
  readonly owner: string
  readonly baseUrl?: string
}

const DEFAULT_BASE_URL = 'https://api.github.com'

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

export function createGitHubAdapter(config: GitHubAdapterConfig): GitAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const { token, owner } = config

  const MAX_429_RETRIES = 3

  async function api(path: string, opts?: RequestInit & { raw?: boolean }, attempt = 0): Promise<any> {
    const startTime = Date.now()
    const fullUrl = `${baseUrl}${path}`
    const method = opts?.method || 'GET'

    try {
      const res = await fetch(fullUrl, {
        ...opts,
        headers: {
          'authorization': `Bearer ${token}`,
          'accept': 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...opts?.headers,
        },
      })

      const duration = Date.now() - startTime

      // Retry a bounded number of times, honoring Retry-After when GitHub
      // sends one. After MAX_429_RETRIES, stop retrying silently and fall
      // through to the normal error path below — a persistent 429 must
      // surface as a thrown GitHubError so the gate loop's own backoff
      // (packages/orchestrator/src/gate/loop.ts) can see and react to it,
      // rather than this function retrying forever with nothing to show
      // for it at the caller.
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = res.headers.get('retry-after')
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000
        console.log(`[github] ${method} ${path} -> 429 (${duration}ms): rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_429_RETRIES})`)
        await new Promise(r => setTimeout(r, delay))
        return api(path, opts, attempt + 1)
      }

      if (opts?.raw) {
        console.log(`[github] ${method} ${path} -> ${res.status} (${duration}ms)`)
        return res
      }

      if (!res.ok) {
        const text = await res.text()
        const errorMessage = `GitHub API ${res.status}: ${text}`
        console.error(`[github] ${method} ${path} -> ${res.status} (${duration}ms): ${text}`)
        throw new GitHubError(errorMessage, res.status, path)
      }

      console.log(`[github] ${method} ${path} -> ${res.status} (${duration}ms)`)
      return res.json()
    } catch (error: any) {
      const duration = Date.now() - startTime
      if (error instanceof GitHubError) throw error
      console.error(`[github] ${method} ${path} -> ERROR (${duration}ms): ${error.message}`)
      throw new GitHubError(
        `Failed to communicate with GitHub API for ${path}`,
        500,
        path,
      )
    }
  }

  let defaultBranchCache: Record<string, string> = {}

  async function getDefaultBranch(repo: string): Promise<string> {
    if (!defaultBranchCache[repo]) {
      const data = await api(`/repos/${owner}/${repo}`)
      defaultBranchCache[repo] = data.default_branch
    }
    return defaultBranchCache[repo]!
  }

  function assertNotProtected(repo: string, branch: string) {
    const protectedBranches = ['main', 'master', 'develop', 'production']
    if (protectedBranches.includes(branch)) {
      throw new GitHubError(
        `Refusing to write to protected branch "${branch}". Agents must work on feature branches.`,
        403,
        `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      )
    }
  }

  function toPRDetails(data: any): PRDetails {
    return {
      id: String(data.number),
      url: data.html_url,
      title: data.title,
      body: data.body ?? '',
      headSha: data.head.sha,
      headRef: data.head.ref,
      baseRef: data.base.ref,
      authorLogin: data.user?.login ?? '',
      labels: (data.labels as any[]).map((l: any) => (typeof l === 'string' ? l : l.name)),
      draft: Boolean(data.draft),
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
    }
  }

  return {
    async getFile(repo, path, ref) {
      const refParam = ref ? `?ref=${ref}` : ''
      try {
        const data = await api(`/repos/${owner}/${repo}/contents/${path}${refParam}`)
        return {
          path: data.path,
          content: atob(data.content.replace(/\n/g, '')),
          encoding: 'utf-8' as const,
        }
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return null
        throw err
      }
    },

    async getTree(repo, path, ref) {
      const resolvedRef = ref ?? await getDefaultBranch(repo)
      const data = await api(`/repos/${owner}/${repo}/git/trees/${resolvedRef}?recursive=true`)
      const prefix = path ? `${path}/` : ''

      return (data.tree as any[])
        .filter((e: any) => {
          if (!prefix) return !e.path.includes('/')
          return e.path.startsWith(prefix)
        })
        .map((e: any): FileEntry => ({
          path: e.path,
          type: e.type === 'tree' ? 'dir' : 'file',
          size: e.size,
        }))
    },

    async createBranch(repo, name, fromRef) {
      assertNotProtected(repo, name)
      const resolvedRef = fromRef ?? await getDefaultBranch(repo)
      const refData = await api(`/repos/${owner}/${repo}/git/ref/heads/${resolvedRef}`)
      const sha = refData.object.sha

      try {
        await api(`/repos/${owner}/${repo}/git/refs`, {
          method: 'POST',
          body: JSON.stringify({
            ref: `refs/heads/${name}`,
            sha,
          }),
        })
      } catch (err) {
        // Idempotent: 422 means branch already exists
        if (err instanceof GitHubError && err.status === 422) return
        throw err
      }
    },

    async commitFiles(repo, branch, files, message) {
      assertNotProtected(repo, branch)
      const branchData = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
      const baseSha = branchData.object.sha

      const commitData = await api(`/repos/${owner}/${repo}/git/commits/${baseSha}`)
      const baseTreeSha = commitData.tree.sha

      const tree = await Promise.all(
        files.map(async (file: FileWrite) => {
          const blob = await api(`/repos/${owner}/${repo}/git/blobs`, {
            method: 'POST',
            body: JSON.stringify({
              content: file.content,
              encoding: 'utf-8',
            }),
          })
          return {
            path: file.path,
            mode: '100644',
            type: 'blob',
            sha: blob.sha,
          }
        }),
      )

      const newTree = await api(`/repos/${owner}/${repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree,
        }),
      })

      const newCommit = await api(`/repos/${owner}/${repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: newTree.sha,
          parents: [baseSha],
        }),
      })

      await api(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: JSON.stringify({
          sha: newCommit.sha,
          force: true,
        }),
      })

      return newCommit.sha
    },

    async createPR(repo, branch, title, body) {
      const existing = await api(
        `/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
      )

      if (existing.length > 0) {
        const pr = existing[0]
        return {
          id: String(pr.number),
          url: pr.html_url,
          title: pr.title,
          body: pr.body ?? '',
          branch,
          status: 'open' as const,
        }
      }

      const defaultBranch = await getDefaultBranch(repo)
      const data = await api(`/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          body,
          head: branch,
          base: defaultBranch,
        }),
      })

      return {
        id: String(data.number),
        url: data.html_url,
        title: data.title,
        body: data.body ?? '',
        branch,
        status: 'open' as const,
      }
    },

    async getPRDiff(repo, prId) {
      const res = await api(`/repos/${owner}/${repo}/pulls/${prId}`, {
        raw: true,
        headers: { accept: 'application/vnd.github.diff' },
      })
      return res.text()
    },

    async addPRComment(repo, prId, body) {
      await api(`/repos/${owner}/${repo}/issues/${prId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      })
    },

    async mergePR(repo, prId, options?: MergeOptions) {
      const body: Record<string, unknown> = { merge_method: 'squash' }
      if (options?.commitTitle) body.commit_title = options.commitTitle
      if (options?.commitMessage) body.commit_message = options.commitMessage

      await api(`/repos/${owner}/${repo}/pulls/${prId}/merge`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },

    async getRecentCommits(repo, path, n = 10) {
      const data = await api(
        `/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=${n}`,
      )
      return (data as any[]).map((c: any): Commit => ({
        sha: c.sha,
        message: c.commit.message,
        author: c.commit.author.name,
        date: new Date(c.commit.author.date),
      }))
    },

    async listOpenPRs(repo) {
      const results: PRDetails[] = []
      let page = 1
      // Paginate defensively: a busy repo can have more than one page of open PRs.
      while (true) {
        const data = await api(`/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`)
        const items = data as any[]
        results.push(...items.map(toPRDetails))
        if (items.length < 100) break
        page++
      }
      return results
    },

    async getPR(repo, prId) {
      try {
        const data = await api(`/repos/${owner}/${repo}/pulls/${prId}`)
        return toPRDetails(data)
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return null
        throw err
      }
    },

    async getCheckStatus(repo, sha): Promise<CheckStatus> {
      const [statusData, checksData] = await Promise.all([
        api(`/repos/${owner}/${repo}/commits/${sha}/status`),
        api(`/repos/${owner}/${repo}/commits/${sha}/check-runs`),
      ])

      const results: CheckStatus[] = []

      // Legacy combined "status" API (statuses/status contexts, e.g. external CI)
      if (Array.isArray(statusData?.statuses) && statusData.statuses.length > 0) {
        if (statusData.state === 'failure' || statusData.state === 'error') results.push('failure')
        else if (statusData.state === 'success') results.push('success')
        else results.push('pending')
      }

      // Checks API (GitHub Actions and check-run-based integrations)
      for (const run of (checksData?.check_runs as any[]) ?? []) {
        if (run.status !== 'completed') {
          results.push('pending')
        } else if (run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped') {
          results.push('success')
        } else {
          // failure, cancelled, timed_out, action_required, stale
          results.push('failure')
        }
      }

      // No checks configured at all: treat as pending, never as an implicit pass.
      if (results.length === 0) return 'pending'
      if (results.some(r => r === 'failure')) return 'failure'
      if (results.every(r => r === 'success')) return 'success'
      return 'pending'
    },

    async listComments(repo, prId) {
      const results: PRCommentEntry[] = []
      let page = 1
      // Paginate: gate correctness depends on seeing every comment (e.g. a
      // later "changes needed" on page 2 must not be missed because an
      // earlier "approve as-is" on page 1 looked sufficient).
      while (true) {
        const data = await api(`/repos/${owner}/${repo}/issues/${prId}/comments?per_page=100&page=${page}`)
        const items = data as any[]
        results.push(...items.map((c: any): PRCommentEntry => ({
          id: String(c.id),
          author: c.user?.login ?? '',
          body: c.body ?? '',
          createdAt: new Date(c.created_at),
        })))
        if (items.length < 100) break
        page++
      }
      return results
    },

    async addLabel(repo, prId, label) {
      await api(`/repos/${owner}/${repo}/issues/${prId}/labels`, {
        method: 'POST',
        body: JSON.stringify({ labels: [label] }),
      })
    },

    async removeLabel(repo, prId, label) {
      try {
        await api(`/repos/${owner}/${repo}/issues/${prId}/labels/${encodeURIComponent(label)}`, {
          method: 'DELETE',
        })
      } catch (err) {
        // Idempotent: 404 means the label wasn't present.
        if (err instanceof GitHubError && err.status === 404) return
        throw err
      }
    },

    async getCommitDate(repo, sha) {
      const data = await api(`/repos/${owner}/${repo}/commits/${sha}`)
      // Committer date reflects when the commit entered the branch (survives
      // rebases/amends), which is what "how stale is a verdict" cares about.
      return new Date(data.commit.committer.date)
    },
  }
}
