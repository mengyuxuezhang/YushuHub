// Keep the standalone deployer copy byte-identical (covered by its tests).
// This factory is self-contained so the deployer can send it over SSH.
export function createAdminRuntimeProbe({ fs, cp, path, pm2Bin = 'pm2' }) {
  const real = value => fs.realpathSync(value)
  function processInfo(pid) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      return { pid, ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[1]), cwd: real(`/proc/${pid}/cwd`) }
    } catch { return { pid, ppid: 0, cwd: null } }
  }
  function belongs(pid, rootPid, cwd) {
    const seen = new Set()
    const owner = processInfo(pid)
    if (owner.cwd !== cwd) return false
    while (pid > 1 && !seen.has(pid) && seen.size < 128) {
      if (pid === rootPid) return true
      seen.add(pid)
      pid = processInfo(pid).ppid
    }
    return false
  }
  function inspect({ name, cwd, port }) {
    cwd = real(cwd)
    const rows = JSON.parse(cp.execFileSync(pm2Bin, ['jlist'], { encoding: 'utf8', timeout: 10000 }))
    const processes = rows.map(row => ({
      name: row.name, pid: Number(row.pid || 0), status: row.pm2_env?.status,
      cwd: row.pm2_env?.pm_cwd, script: row.pm2_env?.pm_exec_path,
      configuredPort: Number(row.pm2_env?.AI_ADMIN_PORT) || null,
      mode: row.pm2_env?.exec_mode, restarts: row.pm2_env?.restart_time,
    }))
    let sockets = '', socketError = ''
    try { sockets = cp.execFileSync('ss', ['-H', '-ltnp', `sport = :${port}`], { encoding: 'utf8', timeout: 10000 }) }
    catch (error) { socketError = error.code || 'ss_failed' }
    const ownerPids = [...new Set([...sockets.matchAll(/pid=(\d+),/g)].map(match => Number(match[1])))]
    return { name, cwd, port: Number(port), nodeExecutable: process.execPath, uid: process.getuid?.() ?? null, pm2Command: pm2Bin, pm2Home: process.env.PM2_HOME || null, processes, listening: Boolean(sockets.trim()), socketError, owners: ownerPids.map(processInfo) }
  }
  function assertOwnership(snapshot, { allowStopped = false, previousPid = 0 } = {}) {
    const { name, cwd, port, processes, owners } = snapshot
    const fail = (code, detail) => {
      const error = new Error(`${code}: ${detail} (PM2=${name}, port=${port})`)
      error.diagnostics = snapshot
      throw error
    }
    const named = processes.filter(row => row.name === name)
    if (named.length > 1) fail('PM2_AMBIGUOUS', 'multiple PM2 entries have the selected name')
    const row = named[0]
    let selectedCwd = null
    try { if (row) selectedCwd = real(row.cwd) } catch {}
    if (row && selectedCwd !== cwd) fail('PM2_DIRECTORY_MISMATCH', 'selected PM2 entry belongs to another application directory')
    const same = processes.filter(item => { try { return real(item.cwd) === cwd && item.status === 'online' && item.pid > 0 } catch { return false } })
    if (same.length > 1) fail('PM2_AMBIGUOUS', 'multiple online PM2 processes use this application directory')
    if (snapshot.socketError) fail('PORT_INSPECTION_FAILED', `cannot inspect listeners: ${snapshot.socketError}`)
    if (snapshot.listening && !owners.length) fail('PORT_OWNER_UNAVAILABLE', 'listener exists but its PID is hidden; run as the service owner or root')
    if (owners.length && (!row?.pid || owners.some(owner => !belongs(owner.pid, row.pid, cwd)))) {
      fail('PORT_OWNERSHIP_CONFLICT', 'target port is not owned by the selected PM2 process or its application descendants')
    }
    if (!allowStopped && (row?.status !== 'online' || !row.pid)) fail('PM2_NOT_ONLINE', 'selected PM2 process is not online')
    if (!allowStopped && !owners.length) fail('PORT_NOT_LISTENING', 'application has not opened the target port')
    if (previousPid && row?.pid === previousPid) fail('PM2_PID_UNCHANGED', 'PM2 has not switched to a new PID')
    return row
  }
  return { inspect, assertOwnership }
}
