import { test, expect, describe } from 'bun:test'
import type { GitAdapter, Issue, ProjectConfig } from '@floor-agents/core'
import {
  extractImports,
  resolveImportPath,
  selectFiles,
  RELEVANCE_IMPORT,
} from '../../packages/context-builder/src/file-selector.ts'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIssue(title: string, body = ''): Issue {
  return {
    id: '1',
    title,
    body,
    status: 'in_progress',
    labels: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: 'test-repo',
    repo: 'org/repo',
    language: 'typescript',
    runtime: 'bun',
    structure: {},
    conventions: {},
    packages: [],
    customInstructions: '',
    ...overrides,
  }
}

function makeGitAdapter(files: Record<string, string>): GitAdapter {
  return {
    async getFile(_repo, path) {
      const content = files[path]
      if (content === undefined) return null
      return { path, content, encoding: 'utf-8' }
    },
    async getTree() {
      return []
    },
    async createBranch() {},
    async commitFiles() { return 'sha' },
    async createPR() {
      return { id: '1', url: 'http://example.com', title: '', body: '', branch: '', status: 'open' }
    },
    async getPRDiff() { return '' },
    async addPRComment() {},
    async mergePR() {},
    async getRecentCommits() { return [] },
  }
}

// ── extractImports ─────────────────────────────────────────────────────────────

describe('extractImports', () => {
  test('returns empty array for file with no imports', () => {
    expect(extractImports('const x = 1')).toEqual([])
  })

  test('extracts static import specifiers', () => {
    const content = `
import { foo } from './foo'
import type { Bar } from '../bar'
import * as baz from './baz/index'
`
    const result = extractImports(content)
    expect(result).toContain('./foo')
    expect(result).toContain('../bar')
    expect(result).toContain('./baz/index')
  })

  test('extracts re-export specifiers', () => {
    const content = `export { foo } from './foo'\nexport * from './utils'`
    const result = extractImports(content)
    expect(result).toContain('./foo')
    expect(result).toContain('./utils')
  })

  test('extracts dynamic import specifiers', () => {
    const content = `const mod = await import('./lazy')`
    expect(extractImports(content)).toContain('./lazy')
  })

  test('extracts package imports (for filtering upstream)', () => {
    const content = `import { z } from 'zod'\nimport type { Foo } from '@floor-agents/core'`
    const result = extractImports(content)
    expect(result).toContain('zod')
    expect(result).toContain('@floor-agents/core')
  })

  test('handles mixed imports in one file', () => {
    const content = `
import { createLinearAdapter } from './linear/index.ts'
import { createThingsAdapter } from './things/index.ts'
import type { TaskAdapter } from '@floor-agents/core'
`
    const result = extractImports(content)
    expect(result).toContain('./linear/index.ts')
    expect(result).toContain('./things/index.ts')
    expect(result).toContain('@floor-agents/core')
  })
})

// ── resolveImportPath ──────────────────────────────────────────────────────────

describe('resolveImportPath', () => {
  test('returns null for package imports', () => {
    expect(resolveImportPath('zod', 'src/index.ts')).toBeNull()
    expect(resolveImportPath('@floor-agents/core', 'src/index.ts')).toBeNull()
  })

  test('resolves sibling file', () => {
    expect(resolveImportPath('./utils', 'src/foo.ts')).toBe('src/utils.ts')
  })

  test('resolves sibling file with explicit extension', () => {
    expect(resolveImportPath('./utils.ts', 'src/foo.ts')).toBe('src/utils.ts')
  })

  test('resolves nested relative path', () => {
    expect(resolveImportPath('./linear/index', 'packages/task/src/index.ts'))
      .toBe('packages/task/src/linear/index.ts')
  })

  test('resolves parent directory traversal', () => {
    expect(resolveImportPath('../shared/utils', 'packages/task/src/linear/index.ts'))
      .toBe('packages/task/src/shared/utils.ts')
  })

  test('resolves from root-level file', () => {
    expect(resolveImportPath('./foo', 'index.ts')).toBe('foo.ts')
  })

  test('adds .ts extension only when no extension present', () => {
    expect(resolveImportPath('./adapter.ts', 'src/index.ts')).toBe('src/adapter.ts')
    expect(resolveImportPath('./config.yaml', 'src/index.ts')).toBe('src/config.yaml')
  })
})

// ── selectFiles (import tracing) ───────────────────────────────────────────────

describe('selectFiles — import tracing', () => {
  test('includes imports of directly matched files', async () => {
    const git = makeGitAdapter({
      'packages/task/src/index.ts': `
import { createLinearAdapter } from './linear/index.ts'
import { createThingsAdapter } from './things/index.ts'
import type { TaskAdapter } from '@floor-agents/core'
export { createLinearAdapter, createThingsAdapter }
`,
      'packages/task/src/linear/index.ts': 'export const createLinearAdapter = () => ({})',
      'packages/task/src/things/index.ts': 'export const createThingsAdapter = () => ({})',
    })

    const issue = makeIssue('Fix packages/task/src/index.ts task routing')
    const project = makeProject()

    const { files } = await selectFiles(issue, project, git)

    const paths = files.map(f => f.path)
    expect(paths).toContain('packages/task/src/index.ts')
    expect(paths).toContain('packages/task/src/linear/index.ts')
    expect(paths).toContain('packages/task/src/things/index.ts')
  })

  test('import-traced files have RELEVANCE_IMPORT score', async () => {
    const git = makeGitAdapter({
      'src/router.ts': `import { handler } from './handler'`,
      'src/handler.ts': 'export const handler = () => {}',
    })

    const issue = makeIssue('Update src/router.ts')
    const project = makeProject()

    const { files } = await selectFiles(issue, project, git)

    const handler = files.find(f => f.path === 'src/handler.ts')
    expect(handler).toBeDefined()
    expect(handler!.relevance).toBe(RELEVANCE_IMPORT)
  })

  test('directly matched files keep their higher relevance score', async () => {
    const git = makeGitAdapter({
      'src/router.ts': `import { handler } from './handler'`,
      'src/handler.ts': 'export const handler = () => {}',
    })

    const issue = makeIssue('Both src/router.ts and src/handler.ts need updating')
    const project = makeProject()

    const { files } = await selectFiles(issue, project, git)

    const router = files.find(f => f.path === 'src/router.ts')
    const handler = files.find(f => f.path === 'src/handler.ts')

    expect(router!.relevance).toBeGreaterThan(RELEVANCE_IMPORT)
    // handler.ts is directly mentioned so it keeps its direct relevance
    expect(handler!.relevance).toBeGreaterThan(RELEVANCE_IMPORT)
  })

  test('does not duplicate files already found by keyword matching', async () => {
    const git = makeGitAdapter({
      'src/foo.ts': `import { bar } from './bar'`,
      'src/bar.ts': 'export const bar = 1',
    })

    const issue = makeIssue('Fix src/foo.ts and src/bar.ts')
    const project = makeProject()

    const { files } = await selectFiles(issue, project, git)

    const barEntries = files.filter(f => f.path === 'src/bar.ts')
    expect(barEntries).toHaveLength(1)
  })

  test('skips package imports during tracing', async () => {
    const git = makeGitAdapter({
      'src/index.ts': `import { z } from 'zod'\nimport type { Foo } from '@floor-agents/core'`,
    })

    const issue = makeIssue('Fix src/index.ts')
    const project = makeProject()

    const { files } = await selectFiles(issue, project, git)

    // Should only have src/index.ts — no attempt to trace package imports
    expect(files.map(f => f.path)).toEqual(['src/index.ts'])
  })

  test('gracefully handles imports that do not exist in the repo', async () => {
    const git = makeGitAdapter({
      'src/index.ts': `import { missing } from './does-not-exist'`,
    })

    const issue = makeIssue('Fix src/index.ts')
    const project = makeProject()

    // Should not throw
    const { files } = await selectFiles(issue, project, git)
    expect(files.map(f => f.path)).toEqual(['src/index.ts'])
  })
})
