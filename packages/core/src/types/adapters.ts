// ── Task Manager Adapter ─────────────────────────────────────────────

export type IssueStatus =
  | 'backlog'
  | 'triage'
  | 'in_progress'
  | 'in_review'
  | 'qa'
  | 'done'
  | 'changes_requested'

export type IssueEvent = {
  readonly type: 'created' | 'updated' | 'deleted'
  readonly issue: Issue
}

export type Issue = {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly status: IssueStatus
  readonly labels: readonly string[]
  readonly parentId?: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type CreateIssueData = {
  readonly title: string
  readonly body?: string
  readonly labels?: readonly string[]
  readonly status?: IssueStatus
}

export type UpdateIssueData = Partial<Pick<Issue, 'title' | 'body' | 'status' | 'labels'>>

export type TaskAdapter = {
  watchIssues(filters?: { labels?: string[] }): AsyncIterable<IssueEvent>
  getIssue(issueId: string): Promise<Issue | null>
  createIssue(data: CreateIssueData, parentId?: string): Promise<Issue>
  updateIssue(issueId: string, changes: UpdateIssueData): Promise<void>
  addComment(issueId: string, text: string): Promise<void>
  setStatus(issueId: string, status: IssueStatus): Promise<void>
  setLabel(issueId: string, label: string): Promise<void>
  removeLabel(issueId: string, label: string): Promise<void>
}

// ── Git Platform Adapter ─────────────────────────────────────────────

export type FileContent = {
  readonly path: string
  readonly content: string
  readonly encoding: 'utf-8' | 'base64'
}

export type FileEntry = {
  readonly path: string
  readonly type: 'file' | 'dir'
  readonly size?: number
}

export type Commit = {
  readonly sha: string
  readonly message: string
  readonly author: string
  readonly date: Date
}

export type PullRequest = {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly body: string
  readonly branch: string
  readonly status: 'open' | 'merged' | 'closed'
}

export type FileWrite = {
  readonly path: string
  readonly content: string
}

// ── Review & Gate types (external PR polling/merge) ──────────────────

/** Combined status of a commit's checks, per the review-and-gate protocol:
 *  any failing check wins, all must succeed for 'success', otherwise 'pending'. */
export type CheckStatus = 'success' | 'failure' | 'pending'

export type PRDetails = {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly body: string
  readonly headSha: string
  readonly headRef: string
  readonly baseRef: string
  /** The base branch's head commit sha AT THE TIME THIS PRDetails WAS
   *  FETCHED (GitHub's PR API returns this alongside `base.ref`) — not
   *  merge-base with the head, and not stable across a re-fetch if the
   *  base branch has since moved. Empty string if the platform adapter
   *  could not resolve it. Used by the gate's checklist loader
   *  (gate/checklists.ts) to read a checklist file from the base branch
   *  rather than the PR's own head, so a PR cannot edit the checklist
   *  that reviews it. */
  readonly baseSha: string
  readonly authorLogin: string
  readonly labels: readonly string[]
  readonly draft: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type PRCommentEntry = {
  readonly id: string
  readonly author: string
  readonly body: string
  readonly createdAt: Date
}

export type MergeOptions = {
  readonly commitTitle?: string
  readonly commitMessage?: string
}

export type GitAdapter = {
  getFile(repo: string, path: string, ref?: string): Promise<FileContent | null>
  getTree(repo: string, path: string, ref?: string): Promise<FileEntry[]>
  createBranch(repo: string, name: string, fromRef?: string): Promise<void>
  commitFiles(repo: string, branch: string, files: FileWrite[], message: string): Promise<string>
  createPR(repo: string, branch: string, title: string, body: string): Promise<PullRequest>
  getPRDiff(repo: string, prId: string): Promise<string>
  addPRComment(repo: string, prId: string, body: string): Promise<void>
  /** Optional `options` is additive: existing 2-arg callers merge with no
   *  custom commit title/message (adapter default behavior unchanged). */
  mergePR(repo: string, prId: string, options?: MergeOptions): Promise<void>
  getRecentCommits(repo: string, path: string, n?: number): Promise<Commit[]>

  // Review & gate mode — polling and PR metadata for PRs this process did not create
  listOpenPRs(repo: string): Promise<PRDetails[]>
  getPR(repo: string, prId: string): Promise<PRDetails | null>
  getCheckStatus(repo: string, sha: string): Promise<CheckStatus>
  listComments(repo: string, prId: string): Promise<PRCommentEntry[]>
  addLabel(repo: string, prId: string, label: string): Promise<void>
  removeLabel(repo: string, prId: string, label: string): Promise<void>
  getCommitDate(repo: string, sha: string): Promise<Date>
}

// ── LLM Provider Adapter ─────────────────────────────────────────────

export type ToolDefinition = {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export type ToolCall = {
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string }

export type LLMMessage = {
  readonly role: 'user' | 'assistant'
  readonly content: string | readonly ContentBlock[]
}

export type LLMConfig = {
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly messages: readonly LLMMessage[]
  readonly tools?: readonly ToolDefinition[]
  readonly maxTokens?: number
  readonly temperature?: number
}

export type LLMUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cost: number
}

export type LLMResponse = {
  readonly content: string
  readonly toolCalls: readonly ToolCall[]
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
  readonly usage: LLMUsage
  readonly provider: string
  readonly model: string
  readonly durationMs: number
}

export type LLMAdapter = {
  run(config: LLMConfig): Promise<LLMResponse>
}
