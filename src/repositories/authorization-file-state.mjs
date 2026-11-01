import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

// One management process owns this credential/cache file. Production deployments
// with multiple processes must use the MySQL store, not share a file concurrently.
export function fileStateStore(filename, initial) {
  let pending = Promise.resolve()
  async function read() {
    try { return JSON.parse(await fs.readFile(filename, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return structuredClone(initial); throw error }
  }
  return {
    async read() { await pending; return read() },
    transaction(operation) {
      const task = pending.then(async () => {
        const state = await read(), result = await operation(state)
        await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
        const temp = `${filename}.${crypto.randomUUID()}.tmp`
        try {
          const handle = await fs.open(temp, 'wx', 0o600)
          try { await handle.writeFile(JSON.stringify(state)); await handle.sync() } finally { await handle.close() }
          await fs.rename(temp, filename)
        }
        finally { await fs.rm(temp, { force: true }) }
        return result
      })
      pending = task.catch(() => {})
      return task
    },
  }
}
