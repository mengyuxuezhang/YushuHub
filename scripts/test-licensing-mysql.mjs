import crypto from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import mysql from 'mysql2/promise'

const name = `yushu-license-test-${crypto.randomBytes(6).toString('hex')}`, password = crypto.randomBytes(32).toString('hex')
function docker(args, env = process.env) {
  const result = spawnSync('docker', args, { encoding: 'utf8', env, windowsHide: true })
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr || 'unavailable'}`)
  return result.stdout.trim()
}
let started = false
try {
  docker(['run', '--detach', '--name', name, '--label', 'yushu-purpose=licensing-isolated-test', '--env', 'MYSQL_ROOT_PASSWORD', '--publish', '127.0.0.1::3306', 'mysql:8.4'], { ...process.env, MYSQL_ROOT_PASSWORD: password })
  started = true
  const info = JSON.parse(docker(['inspect', name]))[0], port = Number(info.NetworkSettings.Ports['3306/tcp'][0].HostPort)
  const config = { host: '127.0.0.1', port, user: 'root', password, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true }
  let connection
  for (let attempt = 0; attempt < 60; attempt++) {
    try { connection = await mysql.createConnection(config); break } catch { await new Promise(resolve => setTimeout(resolve, 1000)) }
  }
  if (!connection) throw new Error('Isolated MySQL did not become ready')
  await connection.query('CREATE DATABASE yushu_license_test')
  await connection.query('CREATE DATABASE yushu_gateway_test')
  await connection.end()
  console.log('Running against disposable MySQL databases; no deployment credentials are used.')
  const child = spawn(process.execPath, ['--test', 'src/services/licensing/licensing.mysql.test.mjs'], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, LICENSING_TEST_DB: JSON.stringify(config) },
  })
  process.exitCode = await new Promise(resolve => { child.on('error', () => resolve(1)); child.on('exit', code => resolve(code || 0)) })
} finally {
  if (started) docker(['rm', '--force', name])
}
