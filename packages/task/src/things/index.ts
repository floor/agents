import type {
  TaskAdapter,
  Issue,
  IssueEvent,
} from '@floor-agents/core'
import {
  getTodosByTag,
  getTodoById,
  createTodo,
  appendToNotes,
  completeTodo,
  reopenTodo,
  addTag,
  removeTag,
  thingsStatusToIssueStatus,
  type ThingsTodo,
} from './applescript.ts'
import { watchThingsDb } from './watcher.ts'

function todoToIssue(todo: ThingsTodo): Issue {
  return {
    id: todo.id,
    title: todo.name,
    body: todo.notes,
    status: thingsStatusToIssueStatus(todo.status),
    labels: todo.tags,
    createdAt: new Date(todo.creationDate),
    updatedAt: new Date(todo.modificationDate),
  }
}

export function createThingsAdapter(): TaskAdapter {
  const knownTodos = new Map<string, ThingsTodo>()

  async function diffTodos(tag: string): Promise<IssueEvent[]> {
    const current = await getTodosByTag(tag)
    const currentIds = new Set<string>()
    const events: IssueEvent[] = []

    for (const todo of current) {
      currentIds.add(todo.id)
      const known = knownTodos.get(todo.id)

      if (!known) {
        events.push({ type: 'created', issue: todoToIssue(todo) })
      } else if (todo.modificationDate !== known.modificationDate) {
        events.push({ type: 'updated', issue: todoToIssue(todo) })
      }

      knownTodos.set(todo.id, todo)
    }

    for (const [id, todo] of knownTodos) {
      if (!currentIds.has(id)) {
        events.push({ type: 'deleted', issue: todoToIssue(todo) })
        knownTodos.delete(id)
      }
    }

    return events
  }

  return {
    async *watchIssues(filters) {
      const tag = filters?.labels?.[0] ?? 'agent'

      // Initial scan
      const initial = await diffTodos(tag)
      for (const event of initial) {
        yield event
      }

      // Watch for DB changes
      const eventQueue: IssueEvent[] = []
      let resolve: (() => void) | null = null

      const watcher = await watchThingsDb(async () => {
        try {
          const events = await diffTodos(tag)
          eventQueue.push(...events)
          if (eventQueue.length > 0) resolve?.()
        } catch (err) {
          console.error('[things] watch error:', err)
        }
      })

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
        watcher.stop()
      }
    },

    async getIssue(issueId) {
      const todo = await getTodoById(issueId)
      return todo ? todoToIssue(todo) : null
    },

    async createIssue(data, parentId) {
      const id = await createTodo(data.title, {
        notes: data.body,
        tags: data.labels ? [...data.labels] : undefined,
      })
      const todo = await getTodoById(id)
      if (!todo) throw new Error(`Failed to create todo: ${id}`)
      return todoToIssue(todo)
    },

    async updateIssue(issueId, changes) {
      if (changes.body !== undefined) {
        const todo = await getTodoById(issueId)
        if (todo) {
          // Things doesn't have a direct "set notes" that merges,
          // so we append changes as a comment-like update
        }
      }
      if (changes.status === 'done') {
        await completeTodo(issueId)
      } else if (changes.status) {
        await reopenTodo(issueId)
      }
    },

    async addComment(issueId, text) {
      const timestamp = new Date().toLocaleString()
      await appendToNotes(issueId, `[${timestamp}] ${text}`)
    },

    async setStatus(issueId, status) {
      if (status === 'done') {
        await completeTodo(issueId)
      } else {
        await reopenTodo(issueId)
      }
    },

    async setLabel(issueId, label) {
      await addTag(issueId, label)
    },

    async removeLabel(issueId, label) {
      await removeTag(issueId, label)
    },
  }
}
