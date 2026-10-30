import crypto from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import mysql from 'mysql2/promise'
import { mysqlAccountingStore } from '../src/repositories/accounting.mjs'
import { auditAccounting, migrateAccounting } from '../src/services/licensing/accounting-migration.mjs'
import { createSupplyLedger } from '../src/services/licensing/ledger.mjs'

const argumentsForTest = process.argv.slice(2)
if (argumentsForTest.length > 1 || (argumentsForTest.length && !argumentsForTest[0].startsWith('--test-name-pattern='))) throw new Error('Only an optional --test-name-pattern is supported')
const focused = argumentsForTest.length === 1
if (focused) { if (argumentsForTest[0].length > 220) throw new Error('Bounded test pattern required'); new RegExp(argumentsForTest[0].slice('--test-name-pattern='.length)) }

const name = `yushu-license-test-${crypto.randomBytes(6).toString('hex')}`, password = crypto.randomBytes(32).toString('hex')
function docker(args, env = process.env, input) {
  const result = spawnSync('docker', args, { encoding: 'utf8', env, input, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
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
  const [[server]] = await connection.query('SELECT VERSION() version')
  await connection.query('CREATE DATABASE yushu_license_test')
  await connection.query('CREATE DATABASE yushu_gateway_test')
  await connection.end()
  console.log(`Running against disposable MySQL ${server.version}; no deployment credentials are used.`)
  if (focused) console.log('Focused database regression only; full resource HTTP, supply backup and capacity checks are skipped. Matching domain tests retain their own acceptance checks.')
  const child = spawn(process.execPath, ['--test', ...argumentsForTest, 'src/services/licensing/licensing.mysql.test.mjs'], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, LICENSING_TEST_DB: JSON.stringify(config), LICENSING_TEST_CONTAINER: name },
  })
  process.exitCode = await new Promise(resolve => { child.on('error', () => resolve(1)); child.on('exit', code => resolve(typeof code === 'number' ? code : 1)) })
  if (process.exitCode === 0 && !focused) {
    const resources = spawn(process.execPath, ['scripts/test-authorization-resources.mjs'], {
      stdio: 'inherit', windowsHide: true, env: { ...process.env, LICENSING_TEST_DB: JSON.stringify(config) },
    })
    const resourceCode = await new Promise(resolve => { resources.on('error', () => resolve(1)); resources.on('exit', code => resolve(typeof code === 'number' ? code : 1)) })
    if (resourceCode !== 0) throw new Error('Isolated authorization resource HTTP regression failed')
    // Backup/restore stays inside this disposable container; never print the dump.
    const env = { ...process.env, MYSQL_PWD: password }
    const dump = docker(['exec', '-e', 'MYSQL_PWD', name, 'mysqldump', '-uroot', '--single-transaction', '--set-gtid-purged=OFF', '--routines', '--triggers', 'yushu_gateway_test'], env)
    const admin = await mysql.createConnection(config)
    try { await admin.query('CREATE DATABASE yushu_gateway_restored') } finally { await admin.end() }
    docker(['exec', '-i', '-e', 'MYSQL_PWD', name, 'mysql', '-uroot', 'yushu_gateway_restored'], env, dump)
    const source = mysql.createPool({ ...config, database: 'yushu_gateway_test' }), restored = mysql.createPool({ ...config, database: 'yushu_gateway_restored' })
    try {
      const [books] = await source.query('SELECT book,kind FROM accounting_books')
      for (const item of books) {
        const before = auditAccounting(await mysqlAccountingStore(source, item.book, item.kind).read(), item.kind)
        const after = auditAccounting(await mysqlAccountingStore(restored, item.book, item.kind).read(), item.kind)
        if (before.hash !== after.hash) throw new Error('Restored accounting state differs')
      }
      for (const table of ['accounting_holds', 'ai_end_users', 'ai_credit_ledger']) {
        const [before] = await source.query(`SELECT * FROM ${table}`), [after] = await restored.query(`SELECT * FROM ${table}`)
        const canonicalRows = rows => rows.map(row => JSON.stringify(row)).sort().join('\n')
        if (canonicalRows(before) !== canonicalRows(after)) throw new Error('Restored holds or user rights differ')
      }
      let fenced = false
      try { await restored.query("UPDATE licensing_state SET revision=revision+1 WHERE id='import-source'") } catch (error) { fenced = error.message.includes('ACCOUNTING_STORE_MIGRATED') }
      if (!fenced) throw new Error('Restored legacy fence is missing')
      const ledger = createSupplyLedger({ store: mysqlAccountingStore(restored, 'gateway', 'ledger') })
      await ledger.settle('concurrent-0', '0.5', [], { restored: true })
      await ledger.settle('concurrent-0', '0.5', [], { restored: true })
      if ((await ledger.view('mysql-first')).balance !== '8.500000') throw new Error('Restored settlement not idempotent')
      console.log('Backup/restore: financial hashes, holds, user rights, legacy fences and resumed idempotent settlement passed.')
      await migrateAccounting({ pool: restored, book: 'load-check', kind: 'ledger', sourceId: 'load-legacy' })
      const secondPool = mysql.createPool({ ...config, database: 'yushu_gateway_restored', connectionLimit: 12 })
      try {
        const ledgers = [createSupplyLedger({ store: mysqlAccountingStore(restored, 'load-check', 'ledger') }),
          createSupplyLedger({ store: mysqlAccountingStore(secondPool, 'load-check', 'ledger') })]
        for (let i = 0; i < 20; i++) {
          await ledgers[0].open(`load-${i}`, `load-${i}`)
          await ledgers[0].credit(`load-${i}`, '2', `fund-${i}`, 'test', `voucher-${i}`)
        }
        let next = 0
        const began = Date.now()
        await Promise.all(Array.from({ length: 40 }, (_, worker) => (async () => {
          const instance = ledgers[worker % 2]
          for (;;) {
            const index = next++
            if (index >= 1000) break
            const requestId = `load-request-${index}`
            await instance.reserve({ walletId: `load-${index % 20}`, requestId, amount: '0.03', fingerprint: requestId, snapshot: { version: 1 } })
            await instance.start(requestId)
            await instance.settle(requestId, '0.02', [], { completed: true })
          }
        })()))
        for (let i = 0; i < 20; i++) {
          const wallet = await ledgers[0].view(`load-${i}`)
          if (wallet.balance !== '1.000000' || wallet.reserved !== '0.000000') throw new Error('Concurrent load lost funds or retained holds')
        }
        const report = await ledgers[0].reconciliation()
        if (report.pendingEvents.length !== 200 || report.totals.pendingEvents !== 1000 || report.totals.unknown !== 0) throw new Error('Event backlog reporting is not bounded or complete')
        auditAccounting(await mysqlAccountingStore(restored, 'load-check', 'ledger').read(), 'ledger')
        console.log(`Accounting baseline: 20 wallets, 1000 requests, 40 concurrent workers across two pools; exact funds/zero holds/1000 durable events verified in ${Date.now() - began}ms (database-only, not supplier throughput).`)
      } finally { await secondPool.end() }
    } finally { await Promise.all([source.end(), restored.end()]) }
  }
} finally {
  if (started) docker(['rm', '--force', '--volumes', name])
}
