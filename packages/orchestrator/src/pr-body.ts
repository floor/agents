import type { AgentDefinition, ExecutionState, Issue } from '@floor-agents/core'
import { verificationSummary } from './verification.ts'
import { agentLabel } from './comment-signature.ts'

const SUMMARY_LIMIT = 2000

export type PrBodyInput = {
  readonly issue: Pick<Issue, 'id' | 'title' | 'body' | 'url' | 'key'>
  readonly agent: Pick<AgentDefinition, 'name' | 'llm'>
  readonly state: Pick<ExecutionState, 'costUsd' | 'llmResponse' | 'parsedOutput' | 'verification'>
  /** The repository the PR is opened in, to tell whether the issue lives there too. */
  readonly repo: string
  /** `git diff --stat` for the published commit, when a checkout can produce it. */
  readonly diffStat?: string
}

/**
 * The issue reference a PR carries.
 *
 * `Closes #N` only when the issue is in the PR's own repository — a bare `#N`
 * elsewhere would point at an unrelated issue. GitHub acts on the keyword only
 * for PRs into the default branch; otherwise it remains a readable link.
 */
export function issueReference(issue: Pick<Issue, 'url' | 'key'>, repo: string): string | null {
  if (issue.url) {
    const match = issue.url.match(/^https:\/\/github\.com\/[^/]+\/([^/]+)\/issues\/(\d+)$/)
    if (match && match[1]!.toLowerCase() === repo.toLowerCase()) return `Closes #${match[2]}`
  }
  // A private tracker: the key names the task for anyone who may open it, and
  // gives nothing to anyone who may not.
  if (issue.key) return `Refs ${issue.key}`
  return issue.url ? `Refs ${issue.url}` : null
}

/** Only a public issue's text may be repeated on a public pull request. */
export function isPublicIssue(issue: Pick<Issue, 'url'>): boolean {
  return Boolean(issue.url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(issue.url))
}

const trim = (text: string): string =>
  text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT).trimEnd()}…` : text

/** Below this, a trailing segment is a closing remark, not the report. */
const MIN_REPORT = 120

/**
 * The agent's final report, without the commentary it narrated on the way.
 *
 * Cursor returns every assistant message of the turn joined with no separator —
 * "…leave the rename entries as they are.The 3.0 migration notes now name…" — so
 * the running commentary ("I'll start by reading…") precedes the report. A
 * sentence end glued directly to a capital letter marks each join; the report is
 * the text after the last one. If that tail is too short to be a report, the
 * whole text is kept rather than a fragment.
 */
export function agentReport(text: string): string {
  const joins = [...text.matchAll(/[.!?](?=[A-Z])/g)]
  const last = joins.at(-1)
  if (!last || last.index === undefined) return text.trim()
  const tail = text.slice(last.index + 1).trim()
  return tail.length >= MIN_REPORT ? tail : text.trim()
}

/**
 * The PR description: what changed, then the evidence, then the task.
 *
 * The summary is the agent's own account and says so. A headless agent can
 * report work it did not do, so the diff and the engine's checks — not the
 * summary — are what a reviewer should trust.
 */
export function buildPrBody(input: PrBodyInput): string {
  const { issue, agent, state, repo, diffStat } = input
  const report = state.parsedOutput?.prDescription?.trim() || agentReport(state.llmResponse ?? '')
  const files = state.parsedOutput?.files.map(f => `- \`${f.path}\``) ?? []
  const reference = issueReference(issue, repo)

  const sections = [
    '## Summary',
    '',
    report ? trim(report) : '_The agent reported no summary._',
    '',
    '_The agent’s own account of the change. The evidence is the diff and the engine verification below._',
  ]

  if (diffStat?.trim()) sections.push('', '## Changes', '', '```', diffStat.trim(), '```')
  else if (files.length) sections.push('', '## Changes', '', ...files)

  sections.push(
    '', '## Verification', '',
    state.verification ? verificationSummary(state.verification) : '_No engine verification recorded._',
  )

  if (reference) sections.push('', reference)

  // The task text is folded in only when the task is public. A finding that
  // lives in a private tracker keeps its evidence there; the PR carries the
  // title and the key.
  if (isPublicIssue(issue)) {
    sections.push(
      '', '<details>',
      `<summary>Task: ${issue.title}</summary>`,
      '', issue.body?.trim() || '_No description._', '',
      '</details>',
    )
  } else {
    sections.push('', `**Task:** ${issue.key ? `${issue.key} — ` : ''}${issue.title}`)
  }
  sections.push(
    '',
    // Who wrote it and with what, and nothing else. A cost belongs to the run
    // log, not to a public page: a CLI on a subscription reports none, so this
    // line read "$0.0000" for work that was paid for.
    `**Agent:** ${agentLabel(agent)} · implementer`,
  )

  return sections.join('\n')
}
