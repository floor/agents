import type {
  TaskAdapter,
  Issue,
  IssueEvent,
  IssueStatus,
} from '@floor-agents/core'

export type GitHubIssuesConfig = {
  readonly token: string
  readonly owner: string
  readonly repo: string
}

export function createGitHubIssuesAdapter(config: GitHubIssuesConfig): TaskAdapter {
  return {
    async *watchIssues(filters) {
      // Implementation for polling issues with matching labels every 10 seconds.
      // This requires setting up a loop, fetching issues based on filters (labels),
      // and yielding events.
      console.log(`[github-issues] Watching issues in ${config.owner}/${config.repo} for labels: ${filters}`)

      const interval = 10000 // 10 seconds
      let knownIssues = new Map<string, Issue>([])

      // Helper to fetch issues based on labels (simplified for this implementation sketch)
      const fetchIssues = async () => {
        try {
          // In a real implementation, filters would be parsed to query GitHub API effectively.
          // For demonstration, we assume filtering by labels is done via the API call structure.
          const response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/issues?state=open&labels=${filters.join(',')}`)
          const issues = await response.json()

          const currentIssues = new Map<string, Issue>()
          issues.forEach(issue => {
            currentIssues.set(issue.number.toString(), issue as Issue)
          })

          // Detect created/updated events (simplified logic for demonstration)
          for (const issue of issues) {
            if (!knownIssues.has(issue.number.toString())) {
              yield { type: 'created', issue: issue }
            } else if (knownIssues.get(issue.number.toString())?.updated_at !== issue.updated_at) {
              // Simplified update detection
              yield { type: 'updated', issue: issue }
            }
          }

          knownIssues = currentIssues

        } catch (error) {
          console.error('Error fetching GitHub Issues:', error)
          // Continue polling even if an error occurs
        }
      }

      // Main polling loop
      while (true) {
        try {
          for await (const event of fetchIssues()) {
            yield event
          }
        } catch (e) {
          console.error('Error during issue watching:', e)
        }
        await new Promise(resolve => setTimeout(resolve, interval))
      }
    },

    async getIssue(issueId: string): Promise<Issue | null> {
      // GET /repos/{owner}/{repo}/issues/{number}
      try {
        const response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/issues/${issueId}`)
        if (!response.ok) return null
        return response.json() as Promise<Issue>
      } catch (error) {
        console.error(`Error fetching issue ${issueId}:`, error)
        return null
      }
    },

    async createIssue(data: any, parentId?: string): Promise<Issue> {
      // POST /repos/{owner}/{repo}/issues
      try {
        const response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/issues`, {
          method: 'POST',
          headers: {
            'Authorization': `token ${config.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data),
        })
        if (!response.ok) {
          const errorBody = await response.json()
          throw new Error(`Failed to create issue: ${response.status} - ${JSON.stringify(errorBody)}`)
        }
        return response.json() as Promise<Issue>
      } catch (error) {
        console.error('Error creating GitHub Issue:', error)
        throw error
      }
    },

    async updateIssue(issueId: string, changes: any): Promise<void> {
      // PATCH /repos/{owner}/{repo}/issues/{number}
      try {
        const response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/issues/${issueId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `token ${config.token}`,
            'Accept': 'application/vnd.github.v3+json',
          },
          body: JSON.stringify(changes),
        })
        if (!response.ok) {
          const errorBody = await response.json()
          throw new Error(`Failed to update issue: ${response.status} - ${JSON.stringify(errorBody)}`)
        }
      } catch (error) {
        console.error(`Error updating GitHub Issue ${issueId}:`, error)
        throw error
      }
    },

    async addComment(issueId: string, text: string): Promise<void> {
      // POST /repos/{owner}/{repo}/issues/{number}/comments
      try {
        const response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/issues/${issueId}/comments`, {
          method: 'POST',
          headers: {
            'Authorization': `token ${config.token}`,
            'Accept': 'application/vnd.github.v3+json',
          },
          body: JSON.stringify({ body: text }),
        })
        if (!response.ok) {
          const errorBody = await response.json()
          throw new Error(`Failed to add comment: ${response.status} - ${JSON.stringify(errorBody)}`)
        }
      } catch (error) {
        console.error(`Error adding comment to issue ${issueId}:`, error)
        throw error
      }
    },

    async setStatus(issueId: string, status: IssueStatus): Promise<void> {
      // Map IssueStatus to GitHub state (open/closed)
      const githubStatus = status === 'done' ? 'closed' : 'open'
      await this.updateIssue(issueId, { state: githubStatus })
    },

    async setLabel(issueId: string, label: string): Promise<void> {
      // POST /repos/{owner}/{repo}/issues/{number}/labels
      try {
        const response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/issues/${issueId}/labels`, {
          method: 'POST',
          headers: {
            'Authorization': `token ${config.token}`,
            'Accept': 'application/vnd.github.v3+json',
          },
          body: JSON.stringify({ label: label }),
        })
        if (!response.ok) {
          const errorBody = await response.json()
          throw new Error(`Failed to set label: ${response.status} - ${JSON.stringify(errorBody)}`)
        }
      } catch (error) {
        console.error(`Error setting label ${label} on issue ${issueId}:`, error)
        throw error
      }
    },

    async removeLabel(issueId: string, label: string): Promise<void> {
      // DELETE /repos/{owner}/{repo}/issues/{number}/labels/{label}
      try {
        await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/issues/${issueId}/labels/${label}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `token ${config.token}`,
          },
        })
      } catch (error) {
        console.error(`Error removing label ${label} from issue ${issueId}:`, error)
        throw error
      }
    },
  }
}