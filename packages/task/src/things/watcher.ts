import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { Glob } from 'bun'

export type WatcherCallback = () => void

export async function watchThingsDb(callback: WatcherCallback): Promise<{ stop: () => void }> {
  // Things 3 stores its database in a Group Container
  const base = resolve(
    homedir(),
    'Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac',
  )

  const glob = new Glob('ThingsData-*/Things Database.thingsdatabase/main.sqlite')
  let dbPath: string | null = null

  for await (const match of glob.scan({ cwd: base, absolute: true })) {
    dbPath = match
    break
  }

  if (!dbPath) {
    throw new Error('Things 3 database not found. Is Things 3 installed?')
  }

  let timeout: ReturnType<typeof setTimeout> | null = null

  const watcher = watch(dbPath, () => {
    // Debounce: Things writes to the DB frequently
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(callback, 500)
  })

  return {
    stop() {
      watcher.close()
      if (timeout) clearTimeout(timeout)
    },
  }
}
