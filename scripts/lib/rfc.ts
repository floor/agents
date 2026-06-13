/** Parse an RFC markdown file into a committee issue. */

export type ParsedRfc = {
  readonly id: string
  readonly title: string
  readonly body: string
}

/**
 * Strip YAML frontmatter, derive the title from the first `# heading` (falling
 * back to the filename), and derive the id from the filename without `.md`.
 *
 * @param text     full file contents
 * @param filename file path or name (only the basename is used)
 */
export function parseRfc(text: string, filename: string): ParsedRfc {
  let body = text
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end !== -1) body = body.slice(body.indexOf('\n', end + 1) + 1)
  }

  const base = filename.split('/').pop() ?? 'rfc'
  const heading = body.split('\n').find(l => l.startsWith('# '))
  const title = heading ? heading.replace(/^#\s+/, '').trim() : base
  const id = base.replace(/\.md$/, '')

  return { id, title, body: body.trim() }
}
