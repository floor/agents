// Selects and loads review checklists for a PR, so the gate's reviewer
// prompt can include the checklist(s) that match this PR's label or
// touched paths (a "contains" check on changed-file paths — see
// ChecklistRule.pathContains below for why). The checklists themselves live IN THE TARGET REPO being
// reviewed (e.g. floor/radiooooo's docs/review/*.md), not here — this
// module only knows how to pick file paths from config and fetch their
// content at the PR's own head commit, via GitAdapter.getFile(repo, path,
// ref). Reading at `ref = headSha` (rather than the target repo's default
// branch) is what makes the checklist "travel with the code": a PR that
// adds or edits a checklist sees its own version in its own prompt, and a
// gate reviewing an older PR isn't handed a checklist item that didn't
// exist yet when that PR was opened.

import type { GitAdapter } from '@floor-agents/core'

export type ChecklistRule = {
  /** Matches when the PR carries this label (case-insensitive). */
  readonly label?: string
  /** Matches when at least one changed file's path contains this text.
   *  A plain (case-sensitive) substring check, not a glob or regex — a
   *  changed path is typically repo-relative and nested under a lane
   *  directory (`android/app/.../player/PlayerManager.kt`,
   *  `web/src/auth/session.ts`), so matching "contains" rather than
   *  "starts with" is what lets a directory-shaped pattern like `"auth/"`
   *  or `"player/"`, or a bare file/module name like `"session"`, match
   *  regardless of which lane's directory it's nested under. */
  readonly pathContains?: string
  /** Path to the checklist file, resolved inside the TARGET repo (the
   *  repo the reviewed PR belongs to) — not a path in this repo. */
  readonly file: string
}

export type ChecklistsConfig = {
  readonly rules: readonly ChecklistRule[]
}

export const DEFAULT_CHECKLISTS_CONFIG: ChecklistsConfig = { rules: [] }

/** Returns the deduplicated list of checklist file paths whose rule
 *  matches this PR, in first-seen rule order. A rule with neither `label`
 *  nor `pathContains` set never matches — a malformed/empty rule excludes
 *  its checklist rather than acting as a wildcard that would attach it to
 *  every PR. A rule with both set matches on EITHER condition (an "or"),
 *  same as the README's selection table (label OR path). */
export function selectChecklistFiles(
  rules: readonly ChecklistRule[],
  pr: { readonly labels: readonly string[]; readonly changedFiles: readonly string[] },
): string[] {
  const labels = new Set(pr.labels.map(l => l.toLowerCase()))
  const seen = new Set<string>()
  const files: string[] = []

  for (const rule of rules) {
    const labelMatch = rule.label !== undefined && labels.has(rule.label.toLowerCase())
    const pathMatch = rule.pathContains !== undefined && pr.changedFiles.some(f => f.includes(rule.pathContains!))
    if (!labelMatch && !pathMatch) continue
    if (seen.has(rule.file)) continue
    seen.add(rule.file)
    files.push(rule.file)
  }

  return files
}

export const NO_CHECKLIST_TEXT = "(no checklist matched this PR's labels or changed paths)"

/** Fetches each selected checklist file's content from the target repo AT
 *  `ref` — the PR's own head sha, so the checklist that lands in the
 *  prompt is the one checked out at the commit under review, not
 *  whatever's on the target repo's default branch when the gate happens
 *  to run. A file missing at that ref (renamed, not yet added at this
 *  PR's base, a config typo) is skipped with a logged warning rather than
 *  failing the review — a missing checklist should degrade the prompt,
 *  not block it. Returns `NO_CHECKLIST_TEXT` when no files were selected,
 *  or when every selected file was missing at `ref`. */
export async function loadChecklists(
  git: Pick<GitAdapter, 'getFile'>,
  repo: string,
  ref: string,
  files: readonly string[],
  log: (line: string) => void = () => {},
): Promise<string> {
  const sections: string[] = []

  for (const file of files) {
    const found = await git.getFile(repo, file, ref)
    if (!found) {
      log(`[gate] checklist not found at ${ref.slice(0, 7)}: ${file} — skipping`)
      continue
    }
    const text = found.encoding === 'base64'
      ? Buffer.from(found.content, 'base64').toString('utf-8')
      : found.content
    sections.push(`### ${file}\n\n${text.trim()}`)
  }

  return sections.length > 0 ? sections.join('\n\n---\n\n') : NO_CHECKLIST_TEXT
}
