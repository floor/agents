// Shared by every `Reviewer` package that resolves a git worktree for a
// review (@floor-agents/codex-cli, @floor-agents/antigravity-cli, ...) — see
// review/worktree.ts.

export class WorktreeMismatchError extends Error {
  readonly dir: string
  readonly expectedSha: string
  readonly actualSha: string

  constructor(message: string, dir: string, expectedSha: string, actualSha: string) {
    super(message)
    this.name = 'WorktreeMismatchError'
    this.dir = dir
    this.expectedSha = expectedSha
    this.actualSha = actualSha
  }
}
