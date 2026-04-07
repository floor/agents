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

export async function selectFiles(
  issue: Issue,
  project: ProjectConfig,
  git: GitAdapter,
): Promise<FileSelection> {
  // Get directory tree for orientation
  const rootEntries = await git.getTree(project.repo, '')
  const tree = rootEntries
    .map(e => `${e.type === 'dir' ? '📁' : '  '} ${e.path}`)
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

  // Fetch files that exist, sorted by relevance
  const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1])
  const files: SelectedFile[] = []

  for (const [path, relevance] of sorted) {
    const file = await git.getFile(project.repo, path)
    if (file) {
      files.push({ path: file.path, content: file.content, relevance })
    }
  }

  return { files, tree }
}
