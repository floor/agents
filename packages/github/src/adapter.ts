import type {
  GitAdapter,
  FileContent,
  FileEntry,
  Commit,
  PullRequest,
  FileWrite,
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

  async function api(path: string, opts?: RequestInit & { raw?: boolean }): Promise<any> {
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

      // Log request details (success or retry)
      console.log(`[github] ${method} ${path} -> ${res.status} (${duration}ms)`)

      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after')
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000
        console.log(`[github] ${method} ${path} -> 429 (${duration}ms): Rate limited, retrying in ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
        return api(path, opts)
      }

      if (opts?.raw) return res
      if (!res.ok) {
        const text = await res.text()
        const errorMessage = `GitHub API ${res.status}: ${text}`
        console.error(`[github] ${method} ${path} -> ${res.status} (${duration}ms): ${errorMessage}`)
        throw new GitHubError(
          errorMessage,
          res.status,
          path,
        )
      }

      return res.json()
    } catch (error: any) {
      // This block catches network errors or errors thrown from above if they weren't caught internally (e.g., during fetch setup)
      const duration = Date.now() - startTime
      if (error instanceof GitHubError) {
        // Error already logged when thrown, just rethrow
        throw error
      }
      // Handle generic fetch errors or unexpected issues
      console.error(`[github] ${method} ${path} -> ERROR (${duration}ms): ${error.message}`)
      throw new GitHubError(
        `Failed to communicate with GitHub API for ${path}`,
        500,
        path,
      )
    }
  }

  async function getDefaultBranch(repo: string): Promise<string> {
    const data = await api(`/repos/${owner}/${repo}`)
    return data.default_branch
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

      return (data as any[])
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
      // Get current branch tip
      const branchData = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
      const baseSha = branchData.object.sha

      // Get base tree
      const commitData = await api(`/repos/${owner}/${repo}/git/commits/${baseSha}`)
      const baseTreeSha = commitData.tree.sha

      // Create blobs for each file
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

      // Create new tree
      const newTree = await api(`/repos/${owner}/${repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree,
        }),
      })

      // Create commit
      const newCommit = await api(`/repos/${owner}/${repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: newTree.sha,
          parents: [baseSha],
        }),
      })

      // Update branch ref (force to handle idempotent re-runs)
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
      // Idempotent: check for existing PR on this branch
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

    async mergePR(repo, prId) {
      await api(`/repos/${owner}/${repo}/pulls/${prId}/merge`, {
        method: 'PUT',
        body: JSON.stringify({ merge_method: 'squash' }),
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
  }
}