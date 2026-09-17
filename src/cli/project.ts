import { dirname, join, relative, resolve } from 'node:path'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import type { CompanyConfig, ProjectCommand } from '@floor-agents/core'
import { computeRequiredProviders, validateCompanyConfig } from '@floor-agents/core'
import { gitText } from '../../packages/orchestrator/src/worktree.ts'

export function githubRemote(url: string): { owner: string; repo: string } | null {
  const match = url.trim().match(/^(?:https:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/)
  return match ? { owner: match[1]!, repo: match[2]! } : null
}

export async function initProject(configPath: string, cwd = process.cwd()): Promise<void> {
  const root = await gitText(cwd, ['rev-parse', '--show-toplevel'])
  const remote = githubRemote(await gitText(root, ['remote', 'get-url', 'origin']))
  if (!remote) throw new Error('origin must identify a GitHub repository before initialization')
  let baseBranch: string
  try { baseBranch = (await gitText(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '') }
  catch { baseBranch = await gitText(root, ['branch', '--show-current']) }
  if (!baseBranch) throw new Error('Cannot infer base branch from a detached checkout')

  const verification: ProjectCommand[] = []
  const setup: ProjectCommand[] = []
  const pkg = await Bun.file(join(root, 'package.json')).json().catch(() => null) as { scripts?: Record<string, string> } | null
  let runtime = ''
  let language = ''
  if (pkg) {
    language = await Bun.file(join(root, 'tsconfig.json')).exists() ? 'typescript' : 'javascript'
    runtime = await Bun.file(join(root, 'bun.lock')).exists() || await Bun.file(join(root, 'bun.lockb')).exists() ? 'bun'
      : await Bun.file(join(root, 'pnpm-lock.yaml')).exists() ? 'pnpm'
      : await Bun.file(join(root, 'yarn.lock')).exists() ? 'yarn' : 'npm'
    for (const name of ['typecheck', 'test', 'build']) {
      if (pkg.scripts?.[name]) verification.push({ name, command: [runtime, 'run', name], timeoutMs: 300_000 })
    }
    if (runtime === 'bun') setup.push({ name: 'Install dependencies', command: ['bun', 'install', '--frozen-lockfile'] })
    else if (runtime === 'npm' && await Bun.file(join(root, 'package-lock.json')).exists()) setup.push({ name: 'Install dependencies', command: ['npm', 'ci'] })
    else if (runtime === 'pnpm') setup.push({ name: 'Install dependencies', command: ['pnpm', 'install', '--frozen-lockfile'] })
  } else if (await Bun.file(join(root, 'Cargo.toml')).exists()) {
    language = 'rust'; runtime = 'cargo'
    verification.push({ name: 'Tests', command: ['cargo', 'test', '--locked'] })
  } else if (await Bun.file(join(root, 'go.mod')).exists()) {
    language = 'go'; runtime = 'go'
    verification.push({ name: 'Tests', command: ['go', 'test', './...'] })
  }
  const config = resolve(configPath)
  const dir = dirname(config)
  const prompt = join(dir, 'developer.md')
  if (await Bun.file(config).exists() || await Bun.file(prompt).exists()) throw new Error('Config or developer.md already exists; initialization never overwrites files')
  await mkdir(dir, { recursive: true })
  await writeFile(prompt, 'You implement focused changes in the supplied repository. Read its project instructions and related tests first. Add regression coverage for fixes. Do not commit, push, or create a PR; the engine verifies and publishes your changes.\n', { flag: 'wx' })
  const manifest = {
    name: remote.repo,
    project: { ...remote, name: remote.repo, root: relative(await realpath(dir), root) || '.', baseBranch, language, runtime, setup, verification },
    agents: [{ id: 'developer', name: 'Developer', promptTemplate: './developer.md', llm: { provider: 'claude-code', model: 'sonnet', maxTokens: 16000 }, capabilities: ['read_code', 'write_code', 'write_tests', 'create_pr'], autonomy: 'T1' }],
    guardrails: { maxFilesPerTask: 20, maxFileSizeBytes: 102400, maxTotalOutputBytes: 512000, blockedPaths: ['.env*', '**/.env*', '**/*.pem', '**/*.key', '.github/workflows/**', '.git/**', '.agents/**', '.worktrees/**'], allowedPaths: [], blockedExtensions: [] },
    costs: { maxCostPerTask: 5, maxCostPerDay: 50, warnCostThreshold: 2 },
  }
  await writeFile(config, Bun.YAML.stringify(manifest), { flag: 'wx' })
  console.log(`Created ${config}\nReview the inferred base branch, setup and verification commands. Add .worktrees/ and local run state to your project's .gitignore.`)
  if (!verification.length) console.log('No checks inferred. Add project.verification before running doctor or a task.')
}

export type Diagnostic = { readonly name: string; readonly ok: boolean; readonly detail: string }

export async function doctorProject(company: CompanyConfig, taskAdapter: string, env: NodeJS.ProcessEnv = process.env): Promise<Diagnostic[]> {
  const results: Diagnostic[] = []
  const check = async (name: string, run: () => Promise<string>) => {
    try { results.push({ name, ok: true, detail: await run() }) }
    catch (err) { results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) }) }
  }
  await check('Config', async () => {
    const errors = validateCompanyConfig(company)
    if (errors.length) throw new Error(errors.join('; '))
    return 'valid'
  })
  const root = company.project.root
  const owner = env.GITHUB_OWNER ?? company.project.owner
  const committee = company.agents.some(a => a.capabilities.includes('vote'))
  if (!committee) await check('Verification', async () => {
    if (!root || !company.project.verification?.length) throw new Error('Set project.root and at least one project.verification command')
    return `${company.project.verification.length} engine checks configured`
  })
  if (root) {
    await check('Checkout', async () => {
      const top = await gitText(root, ['rev-parse', '--show-toplevel'])
      const remote = githubRemote(await gitText(root, ['remote', 'get-url', 'origin']))
      if (!remote || remote.owner.toLowerCase() !== owner?.toLowerCase() || remote.repo.toLowerCase() !== company.project.repo.toLowerCase()) throw new Error('origin does not match the configured GitHub owner/repository')
      return top
    })
    await check('Git identity', async () => {
      await gitText(root, ['var', 'GIT_AUTHOR_IDENT'])
      await gitText(root, ['var', 'GIT_COMMITTER_IDENT'])
      return 'author and committer available'
    })
    await check('Base branch', async () => {
      if (!company.project.baseBranch) throw new Error('Set project.baseBranch explicitly')
      await gitText(root, ['check-ref-format', '--branch', company.project.baseBranch])
      await gitText(root, ['ls-remote', '--exit-code', 'origin', `refs/heads/${company.project.baseBranch}`])
      return company.project.baseBranch
    })
    await check('Commands', async () => {
      for (const command of [...company.project.setup ?? [], ...company.project.verification ?? []]) {
        if (!Bun.which(command.command[0]!, { cwd: root })) throw new Error(`Executable not found: ${command.command[0]}`)
      }
      return 'setup/check executables available; commands were not executed'
    })
  }
  for (const agent of company.agents) await check(`Prompt: ${agent.id}`, async () => {
    if (!(await Bun.file(agent.promptTemplate).exists())) throw new Error(`Missing prompt: ${agent.promptTemplate}`)
    return agent.promptTemplate
  })
  await check('GitHub', async () => {
    if (!env.GITHUB_TOKEN || !owner) throw new Error('GITHUB_TOKEN and project.owner (or GITHUB_OWNER) are required')
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(company.project.repo)}`, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Repository access failed (HTTP ${response.status})`)
    const repo = await response.json() as { permissions?: { push?: boolean } }
    if (repo.permissions?.push === false) throw new Error('Token has no push permission')
    return 'repository accessible; local Git push authentication is separate'
  })
  await check('Task source', async () => {
    if (!['linear', 'things', 'github-issues'].includes(taskAdapter)) throw new Error(`Unknown task adapter: ${taskAdapter}`)
    if (taskAdapter === 'linear' && (!env.LINEAR_API_KEY || !env.LINEAR_TEAM_ID)) throw new Error('LINEAR_API_KEY and LINEAR_TEAM_ID are required')
    if (taskAdapter === 'things' && process.platform !== 'darwin') throw new Error('Things requires macOS')
    return `${taskAdapter}: configuration present; issue access checked on run`
  })
  for (const provider of computeRequiredProviders(company.agents)) await check(`Provider: ${provider}`, async () => {
    if (provider === 'claude-code') {
      if (!Bun.which('claude')) throw new Error('claude executable not found; install and authenticate it')
      return 'CLI available; existing login is used during execution'
    }
    const keys: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' }
    const key = keys[provider]
    if (key && !env[key]) throw new Error(`${key} is required`)
    if (!key && !['lmstudio', 'ollama', 'local'].includes(provider)) throw new Error(`Unsupported provider: ${provider}`)
    return key ? 'credential present; model access is checked during execution' : 'local provider configured; availability is checked during execution'
  })
  return results
}
