import fs from 'node:fs/promises'
import { resolveCurrentPm2Process, scheduleVerifiedSelfRestart } from '../self-update-runtime.mjs'
export async function restartAuthorizationConnection({ root, workDir, runCommand, pm2Bin, configuredName, port, version, publicUrl }) {
  const target = await resolveCurrentPm2Process({ runCommand, pm2Bin, configuredName, repoRoot: root })
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 })
  return scheduleVerifiedSelfRestart({ repoRoot: root, workDir, pm2Bin, pm2Name: target.name, previousPid: target.pid, port, expectedVersion: version, delayMs: 2000, publicUrl })
}
