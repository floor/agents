// Selects and loads review checklists for a PR, so the gate's reviewer
// prompt can include the checklist(s) that match this PR's label or
// touched paths (a "contains" check on changed-file paths — see
// ChecklistRule.pathContains below for why). The checklists themselves
// live IN THE TARGET REPO being reviewed (e.g. your-org/your-repo's
// docs/review/*.md), not here — this module only knows how to pick file
// paths from config and fetch their content via
// GitAdapter.getFile(repo, path, ref).
//
// `ref` MUST be the PR's BASE branch head sha, resolved fresh at review
// time, never the PR's own head sha — the caller (gate/loop.ts) is
// responsible for that resolution and for refusing to fall back to the
// head when it fails. Loading from the head would let a PR edit the very
// checklist that reviews it (weaken an item, or repoint a rule at a file
// the PR controls) and get a softer review of itself; loading from the
// base means the checklist a reviewer sees is the one the PR is actually
// being held to, chosen by whoever last touched the base branch, not by
// this PR.

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

/** Per-file and total size caps on the rendered `{{checklists}}` text, so
 *  one huge or malformed checklist file can't blow up the prompt token
 *  budget. Byte-based (UTF-8), not JS string length, since the source can
 *  be any text. */
export const MAX_CHECKLIST_BYTES = 16 * 1024
export const MAX_TOTAL_CHECKLIST_BYTES = 48 * 1024

/** Truncates `text` to at most `maxBytes` UTF-8 bytes, cutting at a byte
 *  boundary. A multi-byte character straddling the cut is dropped/replaced
 *  by `TextDecoder`'s standard lossy behavior rather than thrown on — fine
 *  for a truncation marker's purposes, not fine to rely on for anything
 *  that needs exact content. */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf-8')
  if (buf.byteLength <= maxBytes) return { text, truncated: false }
  return { text: buf.subarray(0, maxBytes).toString('utf-8'), truncated: true }
}

const fileCapMarker = (file: string) =>
  `\n\n[... "${file}" truncated at ${MAX_CHECKLIST_BYTES / 1024}KB — see the file directly for the rest ...]`

const totalCapMarker = (omittedCount: number) =>
  `[checklists truncated at ${MAX_TOTAL_CHECKLIST_BYTES / 1024}KB total` +
  (omittedCount > 0 ? `; ${omittedCount} file(s) omitted entirely` : '') + `]`

/** Fetches each selected checklist file's content from the target repo AT
 *  `ref`, which the caller MUST resolve to the PR's base branch head sha
 *  (see this module's header comment for why) — never the PR's own head.
 *  A file missing at that ref (typo, not yet merged to the base branch) is
 *  skipped with a logged warning rather than failing the review — a
 *  missing checklist should degrade the prompt, not block it. Each file's
 *  rendered content is capped at `MAX_CHECKLIST_BYTES`, and the whole
 *  concatenated result at `MAX_TOTAL_CHECKLIST_BYTES`, each truncation
 *  leaving a visible marker line rather than silently cutting content — a
 *  reviewer prompt that's quietly missing the back half of a checklist is
 *  worse than one that says so. Returns `NO_CHECKLIST_TEXT` when no files
 *  were selected, or when every selected file was missing at `ref`. */
export async function loadChecklists(
  git: Pick<GitAdapter, 'getFile'>,
  repo: string,
  ref: string,
  files: readonly string[],
  log: (line: string) => void = () => {},
): Promise<string> {
  const sections: string[] = []
  let totalBytes = 0
  let omittedCount = 0

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!

    if (totalBytes >= MAX_TOTAL_CHECKLIST_BYTES) {
      // No budget left for this or any later file — stop fetching
      // entirely rather than looping through the rest one at a time.
      omittedCount += files.length - i
      log(`[gate] checklists truncated at ${MAX_TOTAL_CHECKLIST_BYTES} bytes total, ${omittedCount} file(s) omitted`)
      break
    }

    const found = await git.getFile(repo, file, ref)
    if (!found) {
      log(`[gate] checklist not found at ${ref.slice(0, 7)}: ${file} — skipping`)
      continue
    }

    const decoded = found.encoding === 'base64'
      ? Buffer.from(found.content, 'base64').toString('utf-8')
      : found.content

    const perFile = truncateToBytes(decoded.trim(), MAX_CHECKLIST_BYTES)
    let body = perFile.text
    if (perFile.truncated) {
      body += fileCapMarker(file)
      log(`[gate] checklist truncated at ${MAX_CHECKLIST_BYTES} bytes: ${file}`)
    }

    const section = `### ${file}\n\n${body}`
    const sectionBytes = Buffer.byteLength(section, 'utf-8')
    const remaining = MAX_TOTAL_CHECKLIST_BYTES - totalBytes

    if (sectionBytes > remaining) {
      // This section alone would blow the total budget. Truncate it to
      // fit what's left and stop — there's no budget left for any later
      // file either, so count all of them as omitted too.
      const fit = truncateToBytes(section, remaining)
      sections.push(fit.text)
      omittedCount += files.length - i - 1
      totalBytes = MAX_TOTAL_CHECKLIST_BYTES
      log(`[gate] checklists truncated at ${MAX_TOTAL_CHECKLIST_BYTES} bytes total, ${omittedCount} file(s) omitted`)
      break
    }

    sections.push(section)
    totalBytes += sectionBytes
  }

  if (omittedCount > 0) sections.push(totalCapMarker(omittedCount))

  return sections.length > 0 ? sections.join('\n\n---\n\n') : NO_CHECKLIST_TEXT
}
