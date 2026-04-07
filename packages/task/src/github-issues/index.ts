import type {
  TaskAdapter,
  Issue,
  IssueEvent,
  IssueStatus,
  CreateIssueData,
  UpdateIssueData,
} from '@floor-agents/core'

export type GitHubIssuesConfig = {
  readonly token: string
  readonly owner: string
  readonly repo: string
}

const POLL_INTERVAL_MS = 10_000
const BASE_URL = 'https://api.github.com'

type GitHubIssue = {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  labels: { name: string }[]
  created_at: string
  updated_at: string
}

function githubToIssue(gi: GitHubIssue): Issue {
  return {
    id: String(gi.number),
    title: gi.title,
    body: gi.body ?? '',
    status: githubStateToStatus(gi.state),
    labels: gi.labels.map(l => l.name),
    createdAt: new Date(gi.created_at),
    updatedAt: new Date(gi.updated_at),
  }
}

function githubStateToStatus(state: 'open' | 'closed'): IssueStatus {
  return state === 'closed' ? 'done' : 'triage'
}

function statusToGitHubState(status: IssueStatus): 'open' | 'closed' {
  return status === 'done' ? 'closed' : 'open'
}

export function createGitHubIssuesAdapter(config: GitHubIssuesConfig): TaskAdapter {
  const { token, owner, repo } = config

  function headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    }
  }

  async function apiFetch(path: string, options: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: { ...headers(), ...(options.headers as Record<string, string> ?? {}) },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub API ${res.status}: ${text}`)
    }
    if (res.status === 204) return null
    return res.json()
  }

  async function fetchIssuesByLabel(label: string): Promise<GitHubIssue[]> {
    return apiFetch(
      `/repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100`,
    ) as Promise<GitHubIssue[]>
  }

  async function fetchIssue(issueNumber: string): Promise<GitHubIssue | null> {
    try {
      return await apiFetch(`/repos/${owner}/${repo}/issues/${issueNumber}`) as GitHubIssue
    } catch {
      return null
    }
  }

  const knownIssues = new Map<string, string>()

  return {
    async *watchIssues(filters) {
      const label = filters?.labels?.[0] ?? 'floor'

      const initial = await fetchIssuesByLabel(label)
      for (const gi of initial) {
        const id = String(gi.number)
        knownIssues.set(id, gi.updated_at)
        yield { type: 'created' as const, issue: githubToIssue(gi) }
      }

      const eventQueue: IssueEvent[] = []
      let resolve: (() => void) | null = null

      const interval = setInterval(async () => {
        try {
          const current = await fetchIssuesByLabel(label)
          const currentIds = new Set<string>()

          for (const gi of current) {
            const id = String(gi.number)
            currentIds.add(id)
            const knownUpdatedAt = knownIssues.get(id)

            if (!knownUpdatedAt) {
              eventQueue.push({ type: 'created', issue: githubToIssue(gi) })
            } else if (gi.updated_at !== knownUpdatedAt) {
              eventQueue.push({ type: 'updated', issue: githubToIssue(gi) })
            }

            knownIssues.set(id, gi.updated_at)
          }

          for (const [id] of knownIssues) {
            if (!currentIds.has(id)) {
              const gi = await fetchIssue(id)
              if (gi) {
                eventQueue.push({ type: 'deleted', issue: githubToIssue(gi) })
              }
              knownIssues.delete(id)
            }
          }

          if (eventQueue.length > 0) resolve?.()
        } catch (err) {
          console.error('[github-issues] poll error:', err)
        }
      }, POLL_INTERVAL_MS)

      try {
        while (true) {
          if (eventQueue.length === 0) {
            await new Promise<void>(r => { resolve = r })
          }
          while (eventQueue.length > 0) {
            yield eventQueue.shift()!
          }
        }
      } finally {
        clearInterval(interval)
      }
    },

    async getIssue(issueId) {
      const gi = await fetchIssue(issueId)
      return gi ? githubToIssue(gi) : null
    },

    async createIssue(data: CreateIssueData, _parentId?: string) {
      const body: Record<string, unknown> = { title: data.title }
      if (data.body) body.body = data.body
      if (data.labels && data.labels.length > 0) body.labels = data.labels

      const gi = await apiFetch(`/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify(body),
      }) as GitHubIssue

      return githubToIssue(gi)
    },

    async updateIssue(issueId: string, changes: UpdateIssueData) {
      const body: Record<string, unknown> = {}

      if (changes.title !== undefined) body.title = changes.title
      if (changes.body !== undefined) body.body = changes.body
      if (changes.status !== undefined) body.state = statusToGitHubState(changes.status)
      if (changes.labels !== undefined) body.labels = changes.labels

      if (Object.keys(body).length > 0) {
        await apiFetch(`/repos/${owner}/${repo}/issues/${issueId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
      }
    },

    async addComment(issueId: string, text: string) {
      await apiFetch(`/repos/${owner}/${repo}/issues/${issueId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: text }),
      })
    },

    async setStatus(issueId: string, status: IssueStatus) {
      await apiFetch(`/repos/${owner}/${repo}/issues/${issueId}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: statusToGitHubState(status) }),
      })
    },

    async setLabel(issueId: string, label: string) {
      await apiFetch(`/repos/${owner}/${repo}/issues/${issueId}/labels`, {
        method: 'POST',
        body: JSON.stringify({ labels: [label] }),
      })
    },

    async removeLabel(issueId: string, label: string) {
      try {
        await apiFetch(
          `/repos/${owner}/${repo}/issues/${issueId}/labels/${encodeURIComponent(label)}`,
          { method: 'DELETE' },
        )
      } catch {
        // label may not exist — ignore 404
      }
    },
  }
}
