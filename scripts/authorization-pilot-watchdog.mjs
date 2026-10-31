import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileStateStore } from '../src/repositories/licensing-file-state.mjs'
import { ModelCredentialVault } from '../src/services/model-credentials.mjs'
import { createPilotWatchdog, emptyPilotWatchdog } from '../src/services/licensing/pilot-watchdog.mjs'
import { controlledPilotFile, pilotTarget, exclusivePilotCommand } from './pilot-command-runtime.mjs'

try {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification required')
  const [filename, ...extra] = process.argv.slice(2)
  if (extra.length) throw new Error('Use controlled-watchdog-config.json')
  const config = await controlledPilotFile(filename), stateFile = await pilotTarget(config.stateFile)
  if (!/^[A-Za-z0-9_-]+\.service$/.test(config.unit) || !path.isAbsolute(config.primaryConfigFile)) throw new Error('Controlled primary service required')
  const primaryConfig = await controlledPilotFile(config.primaryConfigFile)
  if (new Set([path.resolve(filename), stateFile, path.resolve(config.primaryConfigFile), path.resolve(primaryConfig.stateFile), path.resolve(primaryConfig.keyFile)]).size !== 5) throw new Error('Distinct watchdog and primary files required')
  await exclusivePilotCommand(stateFile, async () => {
    let primary = null, running = false
    try { primary = await controlledPilotFile(primaryConfig.stateFile, { maxBytes: 8 * 1024 * 1024 }) } catch {}
    try {
      const { stdout } = await promisify(execFile)('/usr/bin/systemctl', ['show', config.unit, '-p', 'MainPID', '--value'], { timeout: 5000, maxBuffer: 1024 })
      if (/^[1-9]\d*$/.test(stdout.trim())) {
        const argv = (await fs.readFile(`/proc/${stdout.trim()}/cmdline`, 'utf8')).split('\0')
        running = argv.includes(path.resolve('scripts/authorization-pilot-monitor.mjs')) && argv.includes('run') && argv.includes(config.primaryConfigFile)
      }
    } catch {}
    if (primary?.config?.encrypted) await controlledPilotFile(primaryConfig.keyFile, { json: false, maxBytes: 8192 })
    const watchdog = createPilotWatchdog({ store: fileStateStore(stateFile, emptyPilotWatchdog()), vault: new ModelCredentialVault(primaryConfig.keyFile) })
    const result = await watchdog.tick(primary, primaryConfig.trial.id, running); await watchdog.drain(2)
    console.log(JSON.stringify(result)); if (result.failed.length) process.exitCode = 2
  })
} catch { console.error('PILOT_WATCHDOG_FAILED: inspect controlled primary, separate state, original encryption key and lock'); process.exitCode = 1 }
