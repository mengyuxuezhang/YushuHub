import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import mysql from 'mysql2/promise'
import { paymentFulfillmentHash } from '../src/repositories/payment-fulfillments.mjs'

// Test-only real mysqldump/restore, restricted to the runner's fresh container and
// this test's disposable database. Dump bytes and database passwords stay private.
export async function withPaymentRefundBackup(config, sourceName, verify) {
  const container = process.env.LICENSING_TEST_CONTAINER
  if (!container) return false
  assert.equal(config.host, '127.0.0.1')
  assert(/^yushu-license-test-[a-f0-9]{12}$/.test(container))
  assert(/^yushu_cash_refund_[a-f0-9]{10}$/.test(sourceName))
  const destination = `yushu_cash_restore_${crypto.randomBytes(5).toString('hex')}`
  function docker(args, input) {
    const result = spawnSync('docker', ['exec', ...(input ? ['-i'] : []), '-e', 'MYSQL_PWD', container, ...args], {
      env: { ...process.env, MYSQL_PWD: config.password }, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    })
    if (result.status !== 0) throw new Error('Disposable cash backup/restore command failed')
    return result.stdout
  }
  const admin = await mysql.createConnection(config)
  let source, restored, created = false
  try {
    const dump = docker(['mysqldump', '-uroot', '--single-transaction', '--set-gtid-purged=OFF', '--routines', '--triggers', sourceName])
    await admin.query('CREATE DATABASE ??', [destination]); created = true
    docker(['mysql', '-uroot', destination], dump)
    const exactConfig = { ...config, timezone: 'local', dateStrings: true }
    source = mysql.createPool({ ...exactConfig, database: sourceName })
    restored = mysql.createPool({ ...exactConfig, database: destination })
    const [tables] = await source.query('SHOW TABLES')
    for (const entry of tables) {
      const table = Object.values(entry)[0]
      assert(/^[a-z_]+$/.test(table))
      const [before] = await source.query('SELECT * FROM ??', [table]), [after] = await restored.query('SELECT * FROM ??', [table])
      const hashes = rows => rows.map(row => paymentFulfillmentHash(row)).sort()
      assert.deepEqual(hashes(after), hashes(before), `Restored cash table differs: ${table}`)
    }
    await verify(restored)
    return true
  } finally {
    await Promise.all([source?.end(), restored?.end()])
    if (created) { assert(/^yushu_cash_restore_[a-f0-9]{10}$/.test(destination)); await admin.query('DROP DATABASE ??', [destination]) }
    await admin.end()
  }
}
