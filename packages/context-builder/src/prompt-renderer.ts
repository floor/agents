import type { ProjectConfig, AgentDefinition } from '@floor-agents/core'
import { estimateTokens } from '@floor-agents/core'
import type { SelectedFile } from './file-selector.ts'

export type PromptParts = {
  readonly systemPrompt: string
  readonly estimatedTokens: number
}

const DEFAULT_MAX_CONTEXT_TOKENS = 100_000
const RESERVED_OUTPUT_TOKENS = 4_000

export async function renderPrompt(params: {
  agent: AgentDefinition
  project: ProjectConfig
  tree: string
  files: readonly SelectedFile[]
  maxContextTokens?: number
}): Promise<PromptParts> {
  const { agent, project, tree, files, maxContextTokens } = params
  const budget = (maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS) - RESERVED_OUTPUT_TOKENS

  // Load prompt template from disk if it exists
  let rolePrompt = ''
  try {
    const file = Bun.file(agent.promptTemplate)
    if (await file.exists()) {
      rolePrompt = await file.text()
    }
  } catch {
    // Template not found — use default
  }

  if (!rolePrompt) {
    rolePrompt = `You are a ${agent.id} developer agent.`
  }

  // Build project context
  const projectContext = [
    `Project: ${project.name}`,
    `Language: ${project.language}`,
    `Runtime: ${project.runtime}`,
    ...Object.entries(project.conventions)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${v}`),
  ].join('\n')

  // Build sections with token tracking
  const sections: string[] = [rolePrompt, '', '## Project', projectContext]
  let used = estimateTokens(sections.join('\n'))

  // Directory tree
  const treeSection = `\n## Directory Structure\n\`\`\`\n${tree}\n\`\`\``
  const treeCost = estimateTokens(treeSection)
  if (used + treeCost < budget) {
    sections.push(treeSection)
    used += treeCost
  }

  // Add files within budget, sorted by relevance (already sorted)
  const includedFiles: string[] = []
  for (const file of files) {
    const fileSection = `\n### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``
    const fileCost = estimateTokens(fileSection)
    if (used + fileCost >= budget) {
      console.log(`[context] skipping ${file.path} (over budget)`)
      continue
    }
    includedFiles.push(fileSection)
    used += fileCost
  }

  if (includedFiles.length > 0) {
    sections.push('\n## Relevant Files', ...includedFiles)
  }

  // Custom instructions
  if (project.customInstructions) {
    sections.push('\n## Custom Instructions', project.customInstructions)
    used += estimateTokens(project.customInstructions)
  }

  if (agent.customInstructions) {
    sections.push('\n## Agent Instructions', agent.customInstructions)
    used += estimateTokens(agent.customInstructions)
  }

  // Output format — tool use instructions
  sections.push(
    '',
    '## Output',
    'Think through your approach, then implement the changes.',
    'Use the `write_file` tool for each file you create or modify. Provide the FULL file content.',
    'Use the `pr_description` tool once to provide a clear PR description.',
  )

  const systemPrompt = sections.join('\n')

  return {
    systemPrompt,
    estimatedTokens: estimateTokens(systemPrompt),
  }
}
