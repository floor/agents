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
   *  base branch has since moved; can also lag behind the base branch's
   *  actual current tip (GitHub only updates it on PR sync events).
   *  Empty string if the platform adapter could not resolve it. The
   *  gate's checklist loader (gate/checklists.ts) prefers
   *  `GitAdapter.compare()`'s fresher `baseSha` and uses this field only
   *  as a fallback when `compare()` resolves to `null` (an unresolvable
   *  ref — e.g. a deleted base branch) — NOT on every `compare()`
   *  failure: a thrown error (a genuine API failure) propagates instead
   *  and aborts the pass, same as any other unhandled `GitAdapter` call
   *  in gate/loop.ts, never falling back to this field. Either way, this
   *  field is always a ref outside the PR's control, never the PR's own
   *  head. NOT used as the reviewer prompt's diff base ({{mergeBase}}) at
   *  all — see `CompareResult.mergeBaseSha` for that. */
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

export type CompareResult = {
  /** The `base` ref's current tip commit sha, resolved AT THE TIME OF
   *  THIS CALL — unlike `PRDetails.baseSha`, this reflects the base
   *  branch's actual current head, not a value frozen at PR
   *  creation/last-sync. Used by the gate's checklist loader to fetch
   *  checklist content from a ref outside the PR's control (never the
   *  PR's own head). */
  readonly baseSha: string
  /** The merge-base commit sha of `base` and `head` — the commit where
   *  the PR's branch actually forked off, i.e. the correct diff base
   *  (`git diff mergeBaseSha...head`). Deliberately NOT `baseSha` above:
   *  once the base branch has advanced past the fork point, a diff
   *  against `baseSha` (or the even-staler `PRDetails.baseSha`) pulls in
   *  every commit merged into the base branch after the PR forked,
   *  making them look like part of the PR (see
   *  packages/orchestrator/src/gate/loop.ts's `tryReview` for where this
   *  is handed to the reviewer prompt as `{{mergeBase}}`, and never
   *  `PRDetails.baseSha`). */
  readonly mergeBaseSha: string
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
  /** Resolves, in one call, both the `base` ref's current tip and its
   *  merge-base with `head` — see `CompareResult`'s own doc comments for
   *  why the two differ and what each feeds. `base` is a ref name
   *  (typically a branch); `head` a sha. Returns `null` if either side
   *  can't be resolved (e.g. a deleted base branch), never throws for
   *  that case — callers decide their own fallback per use (gate/loop.ts
   *  has two different fallback policies for the same failure). */
  compare(repo: string, base: string, head: string): Promise<CompareResult | null>
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
