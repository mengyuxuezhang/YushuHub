import fs from 'node:fs/promises'
import path from 'node:path'
import { fileStateStore } from '../src/repositories/licensing-file-state.mjs'
import { ModelCredentialVault } from '../src/services/model-credentials.mjs'
import { checkAuthorizationAvailability, createAvailabilityMonitor, emptyAvailabilityState } from '../src/services/licensing/availability-monitor.mjs'

async function controlled(filename, parse = true) {
  if (!filename || !path.isAbsolute(filename)) throw new Error('Absolute controlled path required')
  const stat = await fs.lstat(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Private controlled file required')
  const value = await fs.readFile(filename, 'utf8')
  return parse ? JSON.parse(value) : value
}
async function location(filename) {
  if (!filename || !path.isAbsolute(filename)) throw new Error('Absolute controlled path required')
  const parent = await fs.realpath(path.dirname(filename))
  for (let current = parent;; current = path.dirname(current)) {
    try { await fs.lstat(path.join(current, '.git')); throw new Error('Monitor files must stay outside Git') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (path.dirname(current) === current) break
  }
  return path.join(parent, path.basename(filename))
}
try {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification required')
  const [command, filename, requestFile] = process.argv.slice(2)
  if (!['tick', 'state', 'configure'].includes(command) || (command === 'configure' ? !requestFile : Boolean(requestFile))) throw new Error('Use tick|state|configure controlled-config.json [controlled-webhook-request.json]')
  const config = await controlled(await location(filename))
  for (const key of ['stateFile', 'keyFile']) if (!config[key] || !path.isAbsolute(config[key]) || path.resolve(config[key]) === path.resolve(filename)) throw new Error('Distinct absolute state/key paths required')
  if (path.resolve(config.stateFile) === path.resolve(config.keyFile)) throw new Error('Distinct state/key paths required')
  config.stateFile = await location(config.stateFile); config.keyFile = await location(config.keyFile)
  const store = fileStateStore(config.stateFile, emptyAvailabilityState())
  for (const file of [config.stateFile, config.keyFile]) {
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Private state/key file required')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if ((await store.read()).config.encrypted) await fs.access(config.keyFile) // Never replace a lost encryption key.
  const monitor = createAvailabilityMonitor({ store, vault: new ModelCredentialVault(config.keyFile), label: config.label,
    check: () => checkAuthorizationAvailability(config) })
  if (command === 'configure') {
    await monitor.configure(await controlled(await location(requestFile)), 'controlled-availability-operator')
    console.log(JSON.stringify({ configured: true }))
  } else if (command === 'tick') {
    const result = await monitor.tick()
    console.log(JSON.stringify({ healthy: result.healthy, firing: result.firing, checkedAt: result.checkedAt, failed: result.failed }))
    process.exitCode = result.healthy ? 0 : 2
  } else console.log(JSON.stringify(await monitor.state()))
} catch {
  console.error('AVAILABILITY_MONITOR_FAILED: inspect controlled configuration, state and service health')
  process.exitCode = 1
}
