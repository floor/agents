import { test, expect } from 'bun:test'
import { resolveAgent } from '@floor-agents/orchestrator'
import type { AgentDefinition, Issue } from '@floor-agents/core'

const agents: AgentDefinition[] = [
  {
    id: 'backend',
    name: 'Backend Dev',
    promptTemplate: 'agents/backend-dev.md',
    llm: { provider: 'anthropic', model: 'test', temperature: 0, maxTokens: 4000 },
    capabilities: ['read_code', 'write_code', 'create_pr'],
    autonomy: 'T1',
    customInstructions: '',
  },
  {
    id: 'frontend',
    name: 'Frontend Dev',
    promptTemplate: 'agents/frontend-dev.md',
    llm: { provider: 'anthropic', model: 'test', temperature: 0, maxTokens: 4000 },
    capabilities: ['read_code', 'write_code', 'create_pr'],
    autonomy: 'T1',
    customInstructions: '',
  },
  {
    id: 'cto',
    name: 'CTO',
    promptTemplate: 'agents/cto.md',
    llm: { provider: 'anthropic', model: 'test', temperature: 0, maxTokens: 4000 },
    capabilities: ['read_code', 'review_pr', 'approve', 'reject'],
    autonomy: 'T1',
    customInstructions: '',
  },
]

function makeIssue(labels: string[]): Issue {
  return {
    id: 'test-1',
    title: 'Test issue',
    body: '',
    status: 'backlog',
    labels,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

test('matches by label to agent id', () => {
  const agent = resolveAgent(makeIssue(['frontend']), agents)
  expect(agent?.id).toBe('frontend')
})

test('falls back to first write_code agent', () => {
  const agent = resolveAgent(makeIssue(['bug']), agents)
  expect(agent?.id).toBe('backend')
})

test('returns null when no agents match', () => {
  const agent = resolveAgent(makeIssue(['review']), [agents[2]!]) // only CTO
  expect(agent).toBeNull()
})
