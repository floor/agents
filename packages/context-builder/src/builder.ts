import type {
  AgentDefinition,
  GitAdapter,
  Issue,
  ProjectConfig,
  TaskAdapter,
  ToolDefinition,
} from '@floor-agents/core'
import { selectFiles } from './file-selector.ts'
import { renderPrompt } from './prompt-renderer.ts'

export type AgentContext = {
  readonly systemPrompt: string
  readonly userMessage: string
  readonly tools: readonly ToolDefinition[]
  readonly estimatedTokens: number
}

export type BuildContextParams = {
  readonly agent: AgentDefinition
  readonly issue: Issue
  readonly project: ProjectConfig
  readonly reviewComments?: string
  readonly previousAttempt?: string
}

export type ContextBuilderDeps = {
  readonly taskAdapter: TaskAdapter
  readonly gitAdapter: GitAdapter
}

const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'write_file',
    description: 'Create or modify a file. Call once per file. Provide the full file content, not a diff.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the repository root' },
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'pr_description',
    description: 'Provide the pull request title and description. Call exactly once after all files.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short PR title' },
        description: { type: 'string', description: 'PR body in markdown' },
      },
      required: ['title', 'description'],
    },
  },
]

export type ContextBuilder = {
  build(params: BuildContextParams): Promise<AgentContext>
}

export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  return {
    async build(params) {
      const { agent, issue, project } = params

      // Select relevant files from the repo
      const { files, tree } = await selectFiles(issue, project, deps.gitAdapter)

      console.log(`[context] selected ${files.length} files for "${issue.title}"`)

      // Render the system prompt with token budgeting
      const { systemPrompt, estimatedTokens } = await renderPrompt({
        agent,
        project,
        tree,
        files,
      })

      // Build user message
      const parts = [`Please implement the following task:\n\n**${issue.title}**`]

      if (issue.body) {
        parts.push(`\n${issue.body}`)
      }

      if (params.reviewComments) {
        parts.push(`\n## Review Comments\n${params.reviewComments}`)
      }

      if (params.previousAttempt) {
        parts.push(`\n## Previous Attempt Notes\n${params.previousAttempt}`)
      }

      return {
        systemPrompt,
        userMessage: parts.join('\n'),
        tools: AGENT_TOOLS,
        estimatedTokens,
      }
    },
  }
}
