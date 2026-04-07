import type { Issue, GitAdapter, ProjectConfig } from '@floor-agents/core'

export type SelectedFile = {
  readonly path: string
  readonly content: string
  readonly relevance: number
}

export type FileSelection = {
  readonly files: readonly SelectedFile[]
  readonly tree: string
}

const RELEVANCE_DIRECT = 10
const RELEVANCE_ROUTE = 5
const RELEVANCE_IDENTIFIER = 3
export const RELEVANCE_IMPORT = 1

/**
 * Extract all static and dynamic import paths from a TypeScript/JavaScript file.
 * Returns only the specifier strings, not yet resolved to file paths.
 */
export function extractImports(content: string): string[] {
  const imports: string[] = []

  // static: import ... from '...'  /  export ... from '...'
  const staticRe = /\bfrom\s+['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = staticRe.exec(content)) !== null) {
    imports.push(m[1]!)
  }

  // dynamic: import('...')
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dynamicRe.exec(content)) !== null) {
    imports.push(m[1]!)
  }

  return imports
}

/**
 * Resolve a relative import specifier to a repo-root-relative file path.
 * Returns null for package imports (non-relative specifiers).
 * Adds a .ts extension when the specifier has no extension.
 */
export function resolveImportPath(importPath: string, fromFile: string): string | null {
  if (!importPath.startsWith('.')) return null

  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
  const segments = dir ? dir.split('/') : []

  for (const seg of importPath.split('/')) {
    if (seg === '..') {
      segments.pop()
    } else if (seg !== '.') {
      segments.push(seg)
    }
  }

  let resolved = segments.join('/')

  // Add .ts extension when the specifier has no extension
  if (!/\.\w+$/.test(resolved)) {
    resolved += '.ts'
  }

  return resolved
}

export async function selectFiles(
  issue: Issue,
  project: ProjectConfig,
  git: GitAdapter,
): Promise<FileSelection> {
  // Get directory tree for orientation
  const rootEntries = await git.getTree(project.repo, '')
  const tree = rootEntries
    .map(e => `${e.type === 'dir' ? '\uD83D\uDCC1' : '  '} ${e.path}`)
    .join('\n')

  const text = `${issue.title} ${issue.body}`
  const candidates = new Map<string, number>() // path → relevance

  // Match file paths (e.g., src/foo/bar.ts, config.yaml)
  const filePatterns = text.match(/[\w\-./]+\.\w{1,6}/g) ?? []
  for (const p of filePatterns) {
    candidates.set(p, (candidates.get(p) ?? 0) + RELEVANCE_DIRECT)
  }

  // Match route paths that might map to files
  const routePatterns = text.match(/\/api\/[\w\-/]+/g) ?? []
  for (const route of routePatterns) {
    const parts = route.split('/').filter(Boolean)
    const filename = parts[parts.length - 1]
    if (filename && project.structure.backend) {
      const ext = project.language === 'typescript' ? 'ts'
        : project.language === 'javascript' ? 'js'
        : project.language
      const path = `${project.structure.backend}${filename}.${ext}`
      candidates.set(path, (candidates.get(path) ?? 0) + RELEVANCE_ROUTE)
    }
  }

  // Match class-like identifiers
  const identifiers = text.match(
    /\b[A-Z][a-zA-Z]+(?:Controller|Service|Model|Router|Handler)\b/g,
  ) ?? []
  for (const id of identifiers) {
    const snake = id.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1)
    if (project.structure.backend) {
      candidates.set(
        `${project.structure.backend}${snake}.ts`,
        (candidates.get(`${project.structure.backend}${snake}.ts`) ?? 0) + RELEVANCE_IDENTIFIER,
      )
    }
  }

  // Fetch keyword-matched files sorted by relevance
  const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1])
  const files: SelectedFile[] = []
  const fetched = new Set<string>()

  for (const [path, relevance] of sorted) {
    const file = await git.getFile(project.repo, path)
    if (file) {
      files.push({ path: file.path, content: file.content, relevance })
      fetched.add(file.path)
    }
  }

  // v2: follow imports from directly matched files
  const importCandidates = new Map<string, number>()

  for (const file of files) {
    for (const imp of extractImports(file.content)) {
      const resolved = resolveImportPath(imp, file.path)
      if (resolved && !fetched.has(resolved) && !candidates.has(resolved)) {
        // Keep the highest relevance if the same path is imported from multiple files
        if ((importCandidates.get(resolved) ?? 0) < RELEVANCE_IMPORT) {
          importCandidates.set(resolved, RELEVANCE_IMPORT)
        }
      }
    }
  }

  const sortedImports = [...importCandidates.entries()].sort((a, b) => b[1] - a[1])

  for (const [path, relevance] of sortedImports) {
    const file = await git.getFile(project.repo, path)
    if (file && !fetched.has(file.path)) {
      files.push({ path: file.path, content: file.content, relevance })
      fetched.add(file.path)
    }
  }

  return { files, tree }
}
