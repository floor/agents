import { test, expect, describe } from 'bun:test'
import { parseRfc } from '../../scripts/lib/rfc.ts'

describe('parseRfc', () => {
  test('strips YAML frontmatter', () => {
    const text = '---\ncreated: 2026-06-13\nstatus: draft\n---\n\n# RFC-013: Title\n\nBody here.'
    const { body, title } = parseRfc(text, '/x/RFC-013.md')
    expect(title).toBe('RFC-013: Title')
    expect(body.startsWith('# RFC-013: Title')).toBe(true)
    expect(body).not.toContain('created:')
  })

  test('handles content without frontmatter', () => {
    const { title, body } = parseRfc('# Plain RFC\n\nNo frontmatter.', 'plain.md')
    expect(title).toBe('Plain RFC')
    expect(body).toBe('# Plain RFC\n\nNo frontmatter.')
  })

  test('derives id from filename without .md, using basename only', () => {
    const { id } = parseRfc('# T', '/Users/x/docs/rfcs/RFC-013-Spatial.md')
    expect(id).toBe('RFC-013-Spatial')
  })

  test('falls back to filename when no heading', () => {
    const { title } = parseRfc('no heading here\njust text', 'fallback.md')
    expect(title).toBe('fallback.md')
  })

  test('uses the first # heading and trims hashes/space', () => {
    const { title } = parseRfc('intro\n\n#    Spaced Title\n\n## sub', 'x.md')
    expect(title).toBe('Spaced Title')
  })

  test('trims surrounding whitespace from the body', () => {
    const { body } = parseRfc('---\na: b\n---\n\n\n# H\n\nbody\n\n', 'x.md')
    expect(body).toBe('# H\n\nbody')
  })
})
