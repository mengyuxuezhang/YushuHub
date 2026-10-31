import fs from 'node:fs/promises'
import path from 'node:path'
import { fileStateStore } from '../src/repositories/licensing-file-state.mjs'
import { ModelCredentialVault } from '../src/services/model-credentials.mjs'
import { createPilotObservation, emptyPilotObservation } from '../src/services/licensing/pilot-observation.mjs'
import { controlledPilotFile, pilotTarget, exclusivePilotCommand } from './pilot-command-runtime.mjs'

async function main() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification required')
  const [command, filename, requestFile, ...extra] = process.argv.slice(2)
  if (!['initialize', 'tick', 'run', 'state', 'configure', 'review'].includes(command) || extra.length
    || (['configure', 'review'].includes(command) ? !requestFile : Boolean(requestFile))) throw new Error('Use initialize|tick|run|state|configure|review config.json [controlled-request.json]')
  const config = await controlledPilotFile(filename), configFile = await fs.realpath(filename)
  const stateFile = await pilotTarget(config.stateFile), keyFile = await pilotTarget(config.keyFile, { maxBytes: 8192 })
  if (new Set([stateFile, keyFile, configFile]).size !== 3 || !config.trial?.id || !config.sourceFiles
    || Object.keys(config.sourceFiles).sort().join(',') !== config.trial.sources.map(s => s.id).sort().join(',')) throw new Error('Distinct controlled paths and exact source set required')
  for (const source of config.trial.sources) if (!path.isAbsolute(config.sourceFiles[source.id]) || [stateFile, keyFile, configFile].includes(path.resolve(config.sourceFiles[source.id]))) throw new Error('Distinct absolute signed-report paths required')
  const execute = async () => {
    const store = fileStateStore(stateFile, emptyPilotObservation()), persisted = await store.read()
    if (persisted.config.encrypted) await fs.access(keyFile) // Do not replace a lost webhook encryption key.
    const pilot = createPilotObservation({ store, vault: new ModelCredentialVault(keyFile) }), actor = `os-user-${process.getuid?.() ?? 'unknown'}`
    if (command === 'initialize') { console.log(JSON.stringify(await pilot.begin(config.trial, actor))); return }
    if (!persisted.observation) throw new Error('Explicit trial initialization required')
    if (command === 'state') { console.log(JSON.stringify(await pilot.state())); return }
    await pilot.begin(config.trial, actor) // Exact immutable bindings, never silently adopt changed configuration.
    if (command === 'configure') { await pilot.configure(await controlledPilotFile(requestFile), actor); console.log(JSON.stringify({ configured: true })); return }
    if (command === 'review') {
      const input = await controlledPilotFile(requestFile)
      console.log(JSON.stringify(await pilot.review(input.issueId, input.evidenceId, actor))); return
    }
    const tick = async () => {
      const reports = {}
      for (const source of config.trial.sources) {
        try { reports[source.id] = await controlledPilotFile(config.sourceFiles[source.id], { privateFile: false, maxBytes: 32768 }) }
        catch { reports[source.id] = null }
      }
      const result = await pilot.tick(reports); await pilot.drain(2)
      console.log(JSON.stringify(result)); return result
    }
    if (command === 'tick') { const result = await tick(); process.exitCode = ['observing', 'completed'].includes(result.phase) ? 0 : 2; return }
    let active, timer, stopping = false
    let finish
    const stopped = new Promise(resolve => { finish = resolve })
    const stop = () => { if (stopping) return; stopping = true; clearInterval(timer); Promise.resolve(active).finally(finish) }
    const runOnce = () => {
      if (active || stopping) return
      active = (async () => {
        const result = await tick()
        if (result.phase === 'completed') {
          const state = await pilot.state()
          if (state.delivery.deliveries.every(event => ['delivered', 'skipped'].includes(event.state))) stop()
        }
      })().catch(() => { console.error('PILOT_SAMPLE_FAILED: retained prior state; inspect controlled reports and delivery'); process.exitCode = 1; stop() }).finally(() => { active = null })
    }
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
    timer = setInterval(runOnce, 60_000); runOnce()
    await stopped; process.off('SIGTERM', stop); process.off('SIGINT', stop)
  }
  if (command === 'state') await execute()
  else await exclusivePilotCommand(stateFile, execute)
}
try { await main() }
catch { console.error('PILOT_MONITOR_FAILED: check controlled configuration, exclusive writer, reports and original encryption key'); process.exitCode = 1 }
