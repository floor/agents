import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeCommitteeReview, type CommitteePipelineDeps } from '@floor-agents/orchestrator'
import type { AgentDefinition, CompanyConfig, Issue, TaskAdapter } from '@floor-agents/core'
import type { Gateway, TaskAssignment } from '@floor-agents/gateway'

const dir = mkdtempSync(join(tmpdir(), 'persona-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function persona(name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

function extAgent(id: string, promptTemplate: string): AgentDefinition {
  return {
    id, name: id, promptTemplate,
    llm: { provider: 'openai', model: 'local', temperature: 0.3, maxTokens: 100 },
    capabilities: ['review_rfc', 'vote'], autonomy: 'T1', customInstructions: '', external: true,
  }
}

const issue: Issue = {
  id: 'rfc-1', title: 'RFC-013', body: 'proposal', status: 'in_progress',
  labels: ['committee'], createdAt: new Date(), updatedAt: new Date(),
}

const taskAdapter = {
  async getIssue() { return issue },
  async addComment() {},
  async setStatus() {},
  async setLabel() {},
} as unknown as TaskAdapter

const company = { project: { customInstructions: '' } } as unknown as CompanyConfig

describe('external agent personas over the gateway', () => {
  test('each external agent is dispatched with its own promptTemplate as systemPrompt', async () => {
    const assigned: Record<string, string> = {}

    const gateway = {
      assign(agentId: string, task: TaskAssignment) { assigned[agentId] = task.systemPrompt },
      async waitForResult(taskId: string) {
        const agentId = taskId.split(':')[1]!
        return { taskId, agentId, content: 'VOTE: APPROVE', receivedAt: new Date() }
      },
    } as unknown as Gateway

    const codex = extAgent('codex', persona('codex.md', 'CODEX: migration-risk lens'))
    const antigravity = extAgent('antigravity', persona('ag.md', 'ANTIGRAVITY: compositor lens'))

    const deps = {
      company, taskAdapter, gateway,
      contextBuilder: undefined, stateStore: undefined,
      costTracker: { recordCost() {}, getDailyTotal: () => 0, getTaskTotal: () => 0 },
      getAdapter: () => { throw new Error('no internal agents in this test') },
      externalAgents: { timeoutMs: 2000 },
    } as unknown as CommitteePipelineDeps

    const result = await executeCommitteeReview(issue, [codex, antigravity], deps)

    expect(result.votes.length).toBe(2)
    expect(assigned['codex']).toContain('CODEX: migration-risk lens')
    expect(assigned['antigravity']).toContain('ANTIGRAVITY: compositor lens')
    // the whole point: the two prompts are NOT the same shared generic string
    expect(assigned['codex']).not.toEqual(assigned['antigravity'])
  })
})
