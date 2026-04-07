import type { IssueStatus } from '@floor-agents/core'

export type ThingsTodo = {
  readonly id: string
  readonly name: string
  readonly notes: string
  readonly status: 'open' | 'completed' | 'cancelled'
  readonly tags: readonly string[]
  readonly creationDate: string
  readonly modificationDate: string
  readonly project: string | null
}

export function thingsStatusToIssueStatus(status: ThingsTodo['status']): IssueStatus {
  switch (status) {
    case 'open': return 'backlog'
    case 'completed': return 'done'
    case 'cancelled': return 'done'
  }
}

const DELIMITER = '§'

async function run(script: string): Promise<string> {
  const proc = Bun.spawn(['osascript', '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited

  if (code !== 0) {
    throw new Error(`osascript failed (${code}): ${stderr}`)
  }

  return stdout.trim()
}

function escapeAS(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function parseTodo(line: string): ThingsTodo | null {
  const parts = line.split(DELIMITER)
  if (parts.length < 7) return null

  return {
    id: parts[0]!,
    name: parts[1]!,
    notes: parts[2]!,
    status: parts[3] as ThingsTodo['status'],
    tags: parts[4] ? parts[4].split(', ').filter(Boolean) : [],
    creationDate: parts[5]!,
    modificationDate: parts[6]!,
    project: parts[7] || null,
  }
}

export async function getTodosByTag(tag: string): Promise<ThingsTodo[]> {
  const script = `
    tell application "Things3"
      set output to ""
      repeat with aList in {to dos of list "Today", to dos of list "Anytime", to dos of list "Inbox"}
        repeat with t in aList
          set tagNames to ""
          repeat with tg in tags of t
            set tagNames to tagNames & name of tg & ", "
          end repeat
          if tagNames contains "${escapeAS(tag)}" then
            set projName to ""
            try
              set projName to name of project of t
            end try
            set output to output & id of t & "${DELIMITER}" & name of t & "${DELIMITER}" & notes of t & "${DELIMITER}" & status of t & "${DELIMITER}" & tagNames & "${DELIMITER}" & creation date of t & "${DELIMITER}" & modification date of t & "${DELIMITER}" & projName & "\\n"
          end if
        end repeat
      end repeat
      return output
    end tell
  `

  const result = await run(script)
  if (!result) return []

  return result
    .split('\n')
    .filter(Boolean)
    .map(parseTodo)
    .filter((t): t is ThingsTodo => t !== null)
}

export async function getTodoById(todoId: string): Promise<ThingsTodo | null> {
  try {
    const script = `
      tell application "Things3"
        set t to to do id "${escapeAS(todoId)}"
        set tagNames to ""
        repeat with tg in tags of t
          set tagNames to tagNames & name of tg & ", "
        end repeat
        set projName to ""
        try
          set projName to name of project of t
        end try
        return id of t & "${DELIMITER}" & name of t & "${DELIMITER}" & notes of t & "${DELIMITER}" & status of t & "${DELIMITER}" & tagNames & "${DELIMITER}" & creation date of t & "${DELIMITER}" & modification date of t & "${DELIMITER}" & projName
      end tell
    `
    const result = await run(script)
    return parseTodo(result)
  } catch {
    return null
  }
}

export async function createTodo(title: string, opts?: {
  notes?: string
  tags?: string[]
  listName?: string
}): Promise<string> {
  const props = [`name:"${escapeAS(title)}"`]
  if (opts?.notes) props.push(`notes:"${escapeAS(opts.notes)}"`)
  if (opts?.tags?.length) {
    props.push(`tag names:"${opts.tags.map(escapeAS).join(',')}"`)
  }
  if (opts?.listName) props.push(`list name:"${escapeAS(opts.listName)}"`)

  const script = `
    tell application "Things3"
      set newTodo to make new to do with properties {${props.join(', ')}}
      return id of newTodo
    end tell
  `
  return run(script)
}

export async function updateTodoNotes(todoId: string, notes: string): Promise<void> {
  await run(`
    tell application "Things3"
      set notes of to do id "${escapeAS(todoId)}" to "${escapeAS(notes)}"
    end tell
  `)
}

export async function appendToNotes(todoId: string, text: string): Promise<void> {
  await run(`
    tell application "Things3"
      set t to to do id "${escapeAS(todoId)}"
      set notes of t to (notes of t) & "\\n\\n" & "${escapeAS(text)}"
    end tell
  `)
}

export async function completeTodo(todoId: string): Promise<void> {
  await run(`
    tell application "Things3"
      set status of to do id "${escapeAS(todoId)}" to completed
    end tell
  `)
}

export async function reopenTodo(todoId: string): Promise<void> {
  await run(`
    tell application "Things3"
      set status of to do id "${escapeAS(todoId)}" to open
    end tell
  `)
}

export async function addTag(todoId: string, tag: string): Promise<void> {
  await run(`
    tell application "Things3"
      set t to to do id "${escapeAS(todoId)}"
      set tag names of t to (tag names of t) & ",${escapeAS(tag)}"
    end tell
  `)
}

export async function removeTag(todoId: string, tag: string): Promise<void> {
  // Things 3 AppleScript doesn't support removing individual tags,
  // so we rebuild the tag list without the target tag
  await run(`
    tell application "Things3"
      set t to to do id "${escapeAS(todoId)}"
      set currentTags to tag names of t
      set newTags to ""
      repeat with tagItem in every text item of currentTags
        if tagItem is not equal to "${escapeAS(tag)}" then
          if newTags is not "" then set newTags to newTags & ","
          set newTags to newTags & tagItem
        end if
      end repeat
      set tag names of t to newTags
    end tell
  `)
}
