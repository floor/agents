/**
 * @floor/agents — public API.
 *
 * Build an autonomous AI engineering team: orchestrate LLM/CLI agents to review
 * and write code, with a multi-agent committee, a gateway for external agents,
 * and adapters for providers and trackers. Bun runtime.
 *
 * The CLI entry point is `src/main.ts` (the `floor-agents` bin).
 */

// ── Core: config, types, utilities ──────────────────────────────
export * from '@floor-agents/core'

// ── Orchestrator: pipelines, committee, state/cost, worktrees ────
export {
  createOrchestrator,
  createCommitteeOrchestrator,
  executeCommitteeReview,
  executeTask,
  buildSystemPrompt,
  validateAgentOutput,
  createCostTracker,
  createStateStore,
  createWorktree,
  commitAndPushWorktree,
  removeWorktree,
} from '@floor-agents/orchestrator'
export type * from '@floor-agents/orchestrator'

// ── Gateway: external-agent transport ───────────────────────────
export { createGateway, createGatewayClient, validateAgentMessage } from '@floor-agents/gateway'
export type * from '@floor-agents/gateway'

// ── LLM adapters ────────────────────────────────────────────────
export { createAnthropicAdapter } from '@floor-agents/anthropic'
export { createOpenAIAdapter } from '@floor-agents/openai'
export { createGeminiAdapter } from '@floor-agents/gemini'
export { createLMStudioAdapter } from '@floor-agents/lmstudio'
export { createClaudeCodeAdapter } from '@floor-agents/claude-code'

// ── Integrations: git, tasks, context ───────────────────────────
export { createGitHubAdapter, GitHubError, createDiscussionsAdapter } from '@floor-agents/github'
export { createTaskAdapter } from '@floor-agents/task'
export { createContextBuilder, renderPrompt } from '@floor-agents/context-builder'
