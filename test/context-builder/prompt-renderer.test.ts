import { test, expect, describe } from 'bun:test'
import { join } from 'node:path'
import type { AgentDefinition, GitAdapter, Issue, ProjectConfig, TaskAdapter } from '@floor-agents/core'
import { createContextBuilder, renderPrompt, withoutApiToolInstructions } from '@floor-agents/context-builder'

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: 'test-repo',
    repo: 'org/repo',
    language: 'typescript',
    runtime: 'bun',
    structure: {},
    conventions: { quotes: 'single' },
    packages: [],
    customInstructions: '',
    ...overrides,
  }
}

function makeAgent(promptTemplate: string): AgentDefinition {
  return {
    id: 'backend',
    name: 'Backend',
    promptTemplate,
    llm: { provider: 'anthropic', model: 'sonnet', temperature: 0.2, maxTokens: 1000 },
    capabilities: ['write_code'],
    autonomy: 'T1',
    customInstructions: '',
  }
}

const templates = {
  backend: join(process.cwd(), 'agents/backend-dev.md'),
  frontend: join(process.cwd(), 'agents/frontend-dev.md'),
} as const

describe('withoutApiToolInstructions', () => {
  test('drops API-path tool bullets and the full-file-contents rule, keeps the rest', () => {
    const cleaned = withoutApiToolInstructions([
      '## Rules',
      '',
      '- Provide FULL file contents for every file you modify, not diffs',
      '- Use the `write_file` tool for each file you create or modify',
      '- Use the `pr_description` tool once to describe your changes',
      '- Do not modify files outside the scope of the task',
    ].join('\n'))
    expect(cleaned).not.toContain('write_file')
    expect(cleaned).not.toContain('pr_description')
    expect(cleaned).not.toContain('FULL file contents')
    expect(cleaned).toContain('Do not modify files outside the scope of the task')
    expect(cleaned).toContain('## Rules')
  })

  test('drops the shipped QA and PM tool bullets without touching neighbouring rules', async () => {
    const qa = withoutApiToolInstructions(await Bun.file(join(process.cwd(), 'agents/qa.md')).text())
    expect(qa).not.toContain('write_file')
    expect(qa).not.toContain('pr_description')
    expect(qa).not.toContain('FULL file contents')
    expect(qa).toContain('Do not modify source code')

    const pm = withoutApiToolInstructions(await Bun.file(join(process.cwd(), 'agents/pm.md')).text())
    expect(pm).not.toContain('write_file')
    expect(pm).not.toContain('pr_description')
    expect(pm).toContain('Do not write code')
  })

  test('preserves unrelated instructions that mention the same words', () => {
    const cleaned = withoutApiToolInstructions([
      '## Rules',
      '- Use the `write_file` tool for each file you create or modify',
      '- Use the `pr_description` tool once to describe your changes',
      '- Provide FULL file contents for every file you modify, not diffs',
      '- Document write_file in the adapter guide when adding a provider',
      '- Mention pr_description in the architecture overview',
      '- Never print FULL file contents in a status comment',
      '- Do not modify files outside the scope of the task',
    ].join('\n'))
    expect(cleaned).not.toContain('Use the `write_file` tool')
    expect(cleaned).not.toContain('Use the `pr_description` tool')
    expect(cleaned).not.toContain('Provide FULL file contents')
    expect(cleaned).toContain('Document write_file in the adapter guide when adding a provider')
    expect(cleaned).toContain('Mention pr_description in the architecture overview')
    expect(cleaned).toContain('Never print FULL file contents in a status comment')
    expect(cleaned).toContain('Do not modify files outside the scope of the task')
  })
})

describe('renderPrompt', () => {
  for (const [role, promptTemplate] of Object.entries(templates)) {
    test(`${role} role template names API tools, and native rendering strips them`, async () => {
      const raw = await Bun.file(promptTemplate).text()
      expect(raw).toContain('write_file')
      expect(raw).toContain('pr_description')
      expect(raw).toContain('FULL file contents')

      const agent = makeAgent(promptTemplate)
      const project = makeProject()

      const api = await renderPrompt({ agent, project, tree: '', files: [] })
      expect(api.systemPrompt).toContain('write_file')
      expect(api.systemPrompt).toContain('pr_description')
      expect(api.systemPrompt).toContain('## Output')
      expect(api.systemPrompt).toContain('FULL file contents')

      const native = await renderPrompt({ agent, project, tree: '', files: [], native: true })
      expect(native.systemPrompt).not.toContain('write_file')
      expect(native.systemPrompt).not.toContain('pr_description')
      expect(native.systemPrompt).not.toContain('FULL file contents')
      expect(native.systemPrompt).not.toContain('## Output')
      expect(native.systemPrompt).toContain(role === 'backend' ? 'senior backend developer' : 'senior frontend developer')
    })
  }

  test('API agents still receive tool instructions when native is unset', async () => {
    const agent = makeAgent('')
    const api = await renderPrompt({ agent, project: makeProject(), tree: '', files: [] })
    expect(api.systemPrompt).toContain('Use the `write_file` tool')
    expect(api.systemPrompt).toContain('Use the `pr_description` tool')
  })
})

describe('createContextBuilder', () => {
  test('native: true strips a real role template; unset keeps API tools', async () => {
    const git: GitAdapter = {
      getFile: async () => null,
      getTree: async () => [],
      createBranch: async () => {},
      commitFiles: async () => 'sha',
      createPR: async () => ({ id: '1', url: '', title: '', body: '', branch: '', status: 'open' }),
      getPRDiff: async () => '',
      addPRComment: async () => {},
      mergePR: async () => {},
      getRecentCommits: async () => [],
    }
    const builder = createContextBuilder({ taskAdapter: {} as TaskAdapter, gitAdapter: git })
    const agent = makeAgent(templates.backend)
    const issue: Issue = {
      id: '1', title: 'Fix', body: '', labels: [], status: 'backlog', createdAt: new Date(), updatedAt: new Date(),
    }
    const project = makeProject()

    const api = await builder.build({ agent, issue, project })
    expect(api.systemPrompt).toContain('write_file')
    expect(api.systemPrompt).toContain('pr_description')
    expect(api.systemPrompt).toContain('## Output')

    const native = await builder.build({ agent, issue, project, native: true })
    expect(native.systemPrompt).not.toContain('write_file')
    expect(native.systemPrompt).not.toContain('pr_description')
    expect(native.systemPrompt).not.toContain('FULL file contents')
    expect(native.systemPrompt).not.toContain('## Output')
    expect(native.systemPrompt).toContain('senior backend developer')
  })
})
