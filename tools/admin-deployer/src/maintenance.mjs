// Runs on the target server. Keep this function self-contained for SSH transport.
export async function runMaintenance({ fs, path, cp, crypto, createProbe, selector, verifier }, options) {
  const { action, desiredName, publicUrl = '', archive = '', expectedHash = '', planToken = '' } = options
  const cwd = fs.realpathSync(options.cwd), port = Number(options.port)
  if (!path.isAbsolute(cwd) || path.dirname(cwd) === cwd || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid application directory or port')
  if (!fs.statSync(path.join(cwd, '.env')).isFile()) throw new Error('Existing deployment .env is required; use first installation for a new deployment')
  const code = ['cloud', 'src', 'web', 'docs', 'scripts', 'deploy', '.github', '.gitattributes', 'AGENTS.md', 'COMMERCIAL_LICENSE.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md', 'package.json', 'package-lock.json', '.env.example', '.gitignore', 'install.php']
  const run = (bin, args, extra = {}) => cp.execFileSync(bin, args, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024, ...extra })
  const digest = value => crypto.createHash('sha256').update(value).digest('hex')
  const probe = createProbe({ fs, cp, path })
  let stage = '', backup = '', locked = false, changed = false, createdProcess = false, startAttempted = false, selected, version, diskVersion
  const lock = path.join(cwd, 'data', 'self-update', 'maintenance.lock')
  const receipt = { operation: action, startedAt: new Date().toISOString(), phase: 'preflight' }
  const saveReceipt = () => {
    fs.mkdirSync(path.join(cwd, 'data', 'deployer-receipts'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(cwd, 'data', 'deployer-receipts', `${id}.json`), JSON.stringify(receipt, null, 2), { mode: 0o600 })
  }
  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  const installDependencies = () => run('npm', [fs.existsSync(path.join(cwd, 'package-lock.json')) ? 'ci' : 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'])
  const restartEnvironment = () => ({ ...process.env, AI_ADMIN_PORT: String(port), AI_ADMIN_PM2_NAME: selected.name })
  const restart = () => run('pm2', ['restart', selected.name, '--update-env'], { env: restartEnvironment() })
  const verify = (expected, previousPid = 0) => run(process.execPath, ['-e', verifier, selected.name, cwd, String(port), expected, String(previousPid), publicUrl])
  try {
    if (archive) {
      const hash = digest(fs.readFileSync(archive))
      if (!expectedHash || hash !== expectedHash) throw new Error('Uploaded package SHA-256 mismatch')
      const names = run('unzip', ['-Z1', archive]).split(/\r?\n/).filter(Boolean)
      if (!names.length || names.some(name => name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || !code.includes(name.split('/')[0]))) throw new Error('Package contains unsupported or unsafe paths; only application code is allowed')
      stage = fs.mkdtempSync(path.join(path.dirname(archive), 'admin-stage-'))
      run('unzip', ['-q', archive, '-d', stage])
      // Never copy links supplied by an archive into the running deployment.
      const checkTree = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const target = path.join(dir, item.name); if (item.isSymbolicLink()) throw new Error('Package contains a symbolic link'); if (item.isDirectory()) checkTree(target) } }
      checkTree(stage)
    }
    if (action !== 'repair-plan') {
      fs.mkdirSync(path.dirname(lock), { recursive: true })
      try { fs.mkdirSync(lock, { mode: 0o700 }); locked = true }
      catch (error) { if (error.code === 'EEXIST') throw new Error('Another update/repair owns data/self-update/maintenance.lock; inspect its owner before retrying'); throw error }
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ id, pid: process.pid, action, startedAt: receipt.startedAt }), { mode: 0o600 })
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
    if (pkg.name !== 'agent-ai-admin' || !/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Cannot establish the installed application version')
    diskVersion = pkg.version
    if (action === 'rollback') {
      const requested = options.rollbackVersion || ''
      if (requested && !/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/.test(requested)) throw new Error('Invalid rollback version')
      const candidates = []
      for (const base of [path.join(cwd, 'data', 'deployer-backups'), path.join(cwd, 'releases')]) {
        if (!fs.existsSync(base)) continue
        for (const item of fs.readdirSync(base, { withFileTypes: true })) {
          if (!item.isDirectory() || item.isSymbolicLink()) continue
          const dir = path.join(base, item.name)
          try {
            const candidate = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
            if (candidate.name === 'agent-ai-admin' && (requested ? candidate.version === requested : candidate.version !== diskVersion)) candidates.push({ dir, mtime: fs.statSync(dir).mtimeMs })
          } catch {}
        }
      }
      const target = candidates.sort((a, b) => b.mtime - a.mtime)[0]
      if (!target) throw new Error('No matching pre-operation snapshot or legacy release is available')
      stage = fs.mkdtempSync(path.join(cwd, 'data', 'deployer-rollback-'))
      for (const name of code) if (fs.existsSync(path.join(target.dir, name))) fs.cpSync(path.join(target.dir, name), path.join(stage, name), { recursive: true, dereference: false })
    }
    version = stage ? JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).version : diskVersion
    if (stage && JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).name !== 'agent-ai-admin') throw new Error('Wrong application package')
    if (!/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid package version')
    if (action.startsWith('repair') && version !== diskVersion) throw new Error(`Repair requires the installed version ${diskVersion}; package is ${version}. Use upgrade to change versions.`)
    const rows = JSON.parse(run('pm2', ['jlist']))
    selected = JSON.parse(run(process.execPath, ['-e', selector, desiredName, cwd], { input: JSON.stringify(rows) }))
    const snapshot = probe.inspect({ name: selected.name, cwd, port })
    probe.assertOwnership(snapshot, { allowStopped: true })
    const required = ['cloud/ai-admin/server.mjs', 'src/config/env.mjs', 'web/admin-v2/index.html']
    for (const file of required) if (!fs.existsSync(path.join(stage || cwd, file))) throw new Error(`Missing application file ${file}; repair using a ZIP of version ${diskVersion}`)
    for (const name of code) if (fs.existsSync(path.join(cwd, name)) && fs.lstatSync(path.join(cwd, name)).isSymbolicLink()) throw new Error(`Application code path is a symlink: ${name}`)
    const identity = { cwd, port, publicUrl, name: selected.name, pid: selected.pid, status: selected.status, diskVersion, hash: archive ? expectedHash : '', envHash: digest(fs.readFileSync(path.join(cwd, '.env'))), codeHashes: {} }
    for (const file of ['package.json', 'package-lock.json', ...required]) identity.codeHashes[file] = fs.existsSync(path.join(cwd, file)) ? digest(fs.readFileSync(path.join(cwd, file))) : null
    const token = digest(JSON.stringify(identity))
    if (action === 'repair-plan') {
      console.log(JSON.stringify({ applicationDirectory: cwd, port, pm2: selected.name, pid: selected.pid, installedVersion: diskVersion, steps: [stage ? '从同版本 ZIP 恢复程序文件' : '保留当前程序文件', '重新安装生产依赖', '按现有配置校正管理端口和 PM2 实例名称', selected.status === 'missing' ? '使用现有配置重建缺失的 PM2 实例' : '重启现有 PM2 实例', '验证端口归属、运行版本及本地和公网前端资源'], snapshot }, null, 2))
      console.log(`repair_plan=${token}`)
      return
    }
    if (action === 'repair' && (!planToken || token !== planToken)) throw new Error('Repair plan is missing or deployment/package changed; preview the repair plan again')
    console.log(`已确认实例：${selected.name}，端口：${port}，当前版本：${diskVersion}，目标版本：${version}`)
    console.log('正在备份本次操作前的程序文件…')
    backup = path.join(cwd, 'data', 'deployer-backups', id)
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 })
    for (const name of code) if (fs.existsSync(path.join(cwd, name))) fs.cpSync(path.join(cwd, name), path.join(backup, name), { recursive: true, dereference: false })
    receipt.backup = backup; receipt.previousVersion = diskVersion; receipt.targetVersion = version; receipt.pm2 = selected.name
    receipt.phase = 'backup-complete'; saveReceipt()
    changed = true
    if (stage) {
      for (const name of code) {
        fs.rmSync(path.join(cwd, name), { recursive: true, force: true })
        if (fs.existsSync(path.join(stage, name))) fs.cpSync(path.join(stage, name), path.join(cwd, name), { recursive: true })
      }
    }
    receipt.phase = 'dependencies'; saveReceipt()
    console.log('正在重新安装生产依赖…')
    console.log(installDependencies())
    receipt.phase = 'restart'; saveReceipt()
    console.log('正在重启并验证服务…')
    if (selected.status === 'missing') {
      startAttempted = true
      console.log(run('pm2', ['start', 'cloud/ai-admin/server.mjs', '--name', selected.name, '--cwd', cwd, '--interpreter', process.execPath], { env: restartEnvironment() }))
      createdProcess = true
    } else console.log(restart())
    console.log(verify(version, selected.pid))
    receipt.phase = 'verified'; saveReceipt()
    console.log(`running_version=${version}\nbackup_directory=${backup}`)
    try {
      const backupRoot = path.join(cwd, 'data', 'deployer-backups')
      const snapshots = fs.readdirSync(backupRoot, { withFileTypes: true }).filter(item => item.isDirectory() && /^\d{13}-[a-f0-9]{12}$/.test(item.name)).map(item => item.name).sort().reverse()
      for (const old of snapshots.slice(3)) fs.rmSync(path.join(backupRoot, old), { recursive: true, force: true })
    } catch { console.warn('Old code snapshots could not be cleaned; current rollback backup is retained') }

    try { run('pm2', ['save']) } catch { console.warn('PM2 save failed; service is verified but startup persistence needs attention') }
  } catch (error) {
    receipt.error = error.message
    if (error.diagnostics) receipt.diagnostics = error.diagnostics
    if (changed) {
      receipt.phase = 'rollback'; saveReceipt()
      console.error('Verification/installation failed; restoring the exact pre-operation code snapshot')
      try {
        for (const name of code) {
          fs.rmSync(path.join(cwd, name), { recursive: true, force: true })
          if (fs.existsSync(path.join(backup, name))) fs.cpSync(path.join(backup, name), path.join(cwd, name), { recursive: true, dereference: false })
        }
        console.log(installDependencies())
        if (selected.status === 'online') {
          console.log(restart())
          console.log(verify(diskVersion))
          receipt.phase = 'rolled-back-verified'
          console.error(`rolled_back_to=${diskVersion}`)
        } else if (selected.status !== 'missing') {
          run('pm2', ['stop', selected.name]); receipt.phase = 'restored-original-stopped-process'
        } else {
          // This entry was created by this operation, never remove unrelated entries.
          if (createdProcess) run('pm2', ['delete', selected.name])
          else if (startAttempted) throw new Error('PM2 start did not complete; restored code but process state requires inspection')
          receipt.phase = 'restored-original-missing-process'
        }
      } catch (rollbackError) { receipt.phase = 'rollback-failed'; receipt.rollbackError = rollbackError.message; console.error(`Rollback could not be verified: ${rollbackError.message}`) }
      saveReceipt()
    } else if (locked) { receipt.phase = 'preflight-failed'; saveReceipt() }
    if (error.diagnostics) console.error(JSON.stringify(error.diagnostics))
    throw error
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true })
    if (locked) fs.rmSync(lock, { recursive: true, force: true })
  }
}
