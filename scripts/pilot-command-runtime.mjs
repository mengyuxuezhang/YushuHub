import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export async function controlledPilotFile(filename, { privateFile = true, json = true, maxBytes = 262144 } = {}) {
  if (!filename || !path.isAbsolute(filename)) throw new Error('Absolute controlled file required')
  const stat = await fs.lstat(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || (privateFile && process.platform !== 'win32' && stat.mode & 0o077)) throw new Error('Invalid controlled file')
  const value = await fs.readFile(filename, 'utf8')
  return json ? JSON.parse(value) : value
}

export async function pilotTarget(filename, { maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!filename || !path.isAbsolute(filename)) throw new Error('Absolute controlled target required')
  const parent = await fs.realpath(path.dirname(filename)), target = path.join(parent, path.basename(filename))
  try { await controlledPilotFile(target, { json: false, maxBytes }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return target
}

// Linux kernel flock survives exec and releases on exit or a crash. A file-only
// promise queue cannot serialize separate timer/CLI processes. Verify our own
// PID, device and inode in /proc/locks before any state-changing command runs.
export async function exclusivePilotCommand(stateFile, work) {
  if (process.platform !== 'linux') throw new Error('Pilot writer CLI requires Linux flock; domain tests are platform independent')
  const lock = stateFile + '.lock'
  const handle = await fs.open(lock, constants.O_CREAT | constants.O_RDONLY | constants.O_NOFOLLOW, 0o600); await handle.close()
  const stat = await fs.lstat(lock, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077n) throw new Error('Private regular lock required')
  const major = ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & 0xfffff000n), minor = (stat.dev & 0xffn) | ((stat.dev >> 12n) & 0xffffff00n)
  const own = (await fs.readFile('/proc/locks', 'utf8')).split('\n').some(line => {
    const parts = line.trim().split(/\s+/), device = parts[5]?.split(':')
    return parts[1] === 'FLOCK' && parts[2] === 'ADVISORY' && parts[3] === 'WRITE' && parts[4] === String(process.pid) && device?.length === 3
      && BigInt('0x' + device[0]) === major && BigInt('0x' + device[1]) === minor && device[2] === String(stat.ino)
  })
  if (own) return work()
  // A kernel/runtime that cannot expose the inherited lock must fail closed.
  // This flag only DENIES another acquisition; it never grants lock ownership.
  // Without a bound, an unsupported runtime could recursively re-exec forever.
  if (process.env.YUSHU_PILOT_LOCK_ATTEMPTED) throw new Error('Inherited pilot kernel lock could not be verified')
  const child = spawn('/usr/bin/flock', ['--no-fork', '--nonblock', lock, process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit', env: { ...process.env, YUSHU_PILOT_LOCK_ATTEMPTED: '1' },
  })
  const forward = signal => child.kill(signal), term = () => forward('SIGTERM'), interrupt = () => forward('SIGINT')
  process.on('SIGTERM', term); process.on('SIGINT', interrupt)
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) }) }
  finally { process.off('SIGTERM', term); process.off('SIGINT', interrupt) }
}
