/**
 * `owner/name`, the way the git platform writes a repository.
 *
 * A manifest may give `repo: mtrl` with the owner beside it, or in the
 * environment (`GITHUB_OWNER`), or `repo: floor/mtrl` in one piece. A run records
 * the slug, and the API tells projects apart by it — `mtrl` alone would also
 * claim the pull requests of `mtrl-app`.
 */
export function repoSlug(project: { readonly repo: string; readonly owner?: string }, fallbackOwner?: string): string {
  if (project.repo.includes('/')) return project.repo
  const owner = project.owner ?? fallbackOwner
  return owner ? `${owner}/${project.repo}` : project.repo
}
