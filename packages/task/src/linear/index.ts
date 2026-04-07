import type {
  TaskAdapter,
  Issue,
  IssueEvent,
  IssueStatus,
} from '@floor-agents/core'
import {
  getIssuesByLabel,
  getIssueById,
  createLinearIssue,
  updateLinearIssue,
  createLinearComment,
  getWorkflowStates,
  getLabels,
  getIssueLabels,
  type LinearAdapterConfig,
  type LinearIssue,
} from './graphql.ts'

const POLL_INTERVAL_MS = 5_000

function stateTypeToStatus(type: string): IssueStatus {
  switch (type) {
    case 'backlog': return 'backlog'
    case 'unstarted': return 'triage'
    case 'started': return 'in_progress'
    case 'completed': return 'done'
    case 'cancelled': return 'done'
    default: return 'backlog'
  }
}

function linearToIssue(li: LinearIssue): Issue {
  return {
    id: li.id,
    title: li.title,
    body: li.description ?? '',
    status: stateTypeToStatus(li.state.type),
    labels: li.labels.nodes.map(l => l.name),
    parentId: li.parent?.id,
    createdAt: new Date(li.createdAt),
    updatedAt: new Date(li.updatedAt),
  }
}

export function createLinearAdapter(adapterConfig: LinearAdapterConfig): TaskAdapter {
  const config = adapterConfig

  let statesCache: { id: string; name: string; type: string }[] | null = null
  let labelsCache: { id: string; name: string }[] | null = null

  async function getStates() {
    if (!statesCache) statesCache = await getWorkflowStates(config)
    return statesCache
  }

  async function getLabelsList() {
    if (!labelsCache) labelsCache = await getLabels(config)
    return labelsCache
  }

  async function findStateId(status: IssueStatus): Promise<string | undefined> {
    const states = await getStates()
    const typeMap: Record<IssueStatus, string[]> = {
      backlog: ['backlog'],
      triage: ['unstarted'],
      in_progress: ['started'],
      in_review: ['started'],
      qa: ['started'],
      done: ['completed'],
      changes_requested: ['started'],
    }
    const types = typeMap[status]
    const match = states.find(s => types.includes(s.type))
    return match?.id
  }

  async function findLabelId(name: string): Promise<string | undefined> {
    const labels = await getLabelsList()
    return labels.find(l => l.name.toLowerCase() === name.toLowerCase())?.id
  }

  const knownIssues = new Map<string, string>()

  return {
    async *watchIssues(filters) {
      const label = filters?.labels?.[0] ?? 'floor'

      const initial = await getIssuesByLabel(config, label)
      for (const li of initial) {
        knownIssues.set(li.id, li.updatedAt)
        yield { type: 'created' as const, issue: linearToIssue(li) }
      }

      const eventQueue: IssueEvent[] = []
      let resolve: (() => void) | null = null

      const interval = setInterval(async () => {
        try {
          const current = await getIssuesByLabel(config, label)
          const currentIds = new Set<string>()

          for (const li of current) {
            currentIds.add(li.id)
            const knownUpdatedAt = knownIssues.get(li.id)

            if (!knownUpdatedAt) {
              eventQueue.push({ type: 'created', issue: linearToIssue(li) })
            } else if (li.updatedAt !== knownUpdatedAt) {
              eventQueue.push({ type: 'updated', issue: linearToIssue(li) })
            }

            knownIssues.set(li.id, li.updatedAt)
          }

          for (const [id] of knownIssues) {
            if (!currentIds.has(id)) {
              const li = await getIssueById(config, id)
              if (li) {
                eventQueue.push({ type: 'deleted', issue: linearToIssue(li) })
              }
              knownIssues.delete(id)
            }
          }

          if (eventQueue.length > 0) resolve?.()
        } catch (err) {
          console.error('[linear] poll error:', err)
        }
      }, POLL_INTERVAL_MS)

      try {
        while (true) {
          if (eventQueue.length === 0) {
            await new Promise<void>(r => { resolve = r })
          }
          while (eventQueue.length > 0) {
            yield eventQueue.shift()!
          }
        }
      } finally {
        clearInterval(interval)
      }
    },

    async getIssue(issueId) {
      const li = await getIssueById(config, issueId)
      return li ? linearToIssue(li) : null
    },

    async createIssue(data, parentId) {
      const labelIds: string[] = []
      if (data.labels) {
        for (const name of data.labels) {
          const id = await findLabelId(name)
          if (id) labelIds.push(id)
        }
      }

      const li = await createLinearIssue(config, {
        title: data.title,
        description: data.body,
        labelIds: labelIds.length > 0 ? labelIds : undefined,
        parentId,
      })

      return linearToIssue(li)
    },

    async updateIssue(issueId, changes) {
      const input: Record<string, unknown> = {}

      if (changes.title !== undefined) input.title = changes.title
      if (changes.body !== undefined) input.description = changes.body
      if (changes.status !== undefined) {
        const stateId = await findStateId(changes.status)
        if (stateId) input.stateId = stateId
      }
      if (changes.labels !== undefined) {
        const labelIds: string[] = []
        for (const name of changes.labels) {
          const id = await findLabelId(name)
          if (id) labelIds.push(id)
        }
        input.labelIds = labelIds
      }

      if (Object.keys(input).length > 0) {
        await updateLinearIssue(config, issueId, input)
      }
    },

    async addComment(issueId, text) {
      await createLinearComment(config, issueId, text)
    },

    async setStatus(issueId, status) {
      const stateId = await findStateId(status)
      if (stateId) {
        await updateLinearIssue(config, issueId, { stateId })
      }
    },

    async setLabel(issueId, label) {
      const labelId = await findLabelId(label)
      if (!labelId) return

      const current = await getIssueLabels(config, issueId)
      const ids = current.map(l => l.id)
      if (!ids.includes(labelId)) {
        await updateLinearIssue(config, issueId, { labelIds: [...ids, labelId] })
      }
    },

    async removeLabel(issueId, label) {
      const current = await getIssueLabels(config, issueId)
      const filtered = current.filter(l => l.name.toLowerCase() !== label.toLowerCase())
      if (filtered.length !== current.length) {
        await updateLinearIssue(config, issueId, { labelIds: filtered.map(l => l.id) })
      }
    },
  }
}
