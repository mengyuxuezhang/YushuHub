import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import mysql from 'mysql2/promise'
import { paymentFulfillmentHash } from '../src/repositories/payment-fulfillments.mjs'
import { assertAccountingRuntime } from '../src/services/licensing/accounting-mode.mjs'

// Never exports a dump to the repository. Native clients require an explicit
// test-only opt-in; both variants can restore only a newly created owned DB.
export async function verifyRetirementBackup(config, sourceName) {
  assert.equal(config.host, '127.0.0.1'); assert.match(sourceName, /^yushu_resources_local_[a-f0-9]{10}$/)
  const container = process.env.LICENSING_TEST_CONTAINER
  if (container) assert.match(container, /^yushu-license-test-[a-f0-9]{12}$/)
  else assert(process.platform === 'linux' && process.env.LICENSING_TEST_NATIVE_MYSQL === '1', 'Explicit native MySQL acceptance flag required')
  const destination = `yushu_retirement_restore_${crypto.randomBytes(5).toString('hex')}`
  function client(binary, args, input) {
    const target = container ? 'docker' : `/usr/bin/${binary}`
    const parameters = container ? ['exec', ...(input ? ['-i'] : []), '-e', 'MYSQL_PWD', container, binary, `-u${config.user}`, ...args]
      : [`--host=${config.host}`, `--port=${config.port}`, `--user=${config.user}`, ...args]
    const result = spawnSync(target, parameters, { env: { ...process.env, MYSQL_PWD: config.password }, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    if (result.status !== 0) throw new Error('Owned retirement backup/restore client failed; dump and credentials withheld')
    return result.stdout
  }
  const admin = await mysql.createConnection(config)
  let source, restored, created = false
  try {
    const dump = client('mysqldump', ['--single-transaction', '--set-gtid-purged=OFF', '--routines', '--triggers', sourceName])
    await admin.query('CREATE DATABASE ??', [destination]); created = true
    client('mysql', [destination], dump)
    source = mysql.createPool({ ...config, database: sourceName, timezone: 'Z', dateStrings: true })
    restored = mysql.createPool({ ...config, database: destination, timezone: 'Z', dateStrings: true })
    const [tables] = await source.query('SHOW TABLES')
    for (const entry of tables) {
      const table = Object.values(entry)[0]; assert.match(table, /^[a-z_]+$/)
      const [before] = await source.query('SELECT * FROM ??', [table]), [after] = await restored.query('SELECT * FROM ??', [table])
      assert.deepEqual(after.map(paymentFulfillmentHash).sort(), before.map(paymentFulfillmentHash).sort(), `Restored retirement table differs: ${table}`)
    }
    const [beforeTriggers] = await source.query("SELECT TRIGGER_NAME AS name,ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME")
    const [afterTriggers] = await restored.query("SELECT TRIGGER_NAME AS name,ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME")
    assert.deepEqual(afterTriggers, beforeTriggers)
    await assertAccountingRuntime(restored, false)
    await assert.rejects(assertAccountingRuntime(restored, true), { code: 'ACCOUNTING_BOOK_RETIRED' })
    await assert.rejects(restored.query("INSERT INTO accounting_requests(book,id,wallet_id,state,source,updated_at,payload) VALUES ('commerce-v2','restored-bypass','resources-root','running','custom',1,'{}')"), /ACCOUNTING_BOOK_RETIRED/)
    await assert.rejects(restored.query("UPDATE licensing_state SET document=JSON_SET(document,'$.fixture',true) WHERE id='local-resources-v1'"), /ACCOUNTING_BOOK_RETIRED/)
    // An old writer may already hold an RR snapshot. The trigger must read the
    // current mode rather than trust that stale snapshot. Only this owned copy
    // is toggled; the source marker and all business rows stay unchanged.
    await restored.query("UPDATE accounting_runtime_modes SET status='active' WHERE book='commerce-v2'")
    const oldWriter = await restored.getConnection()
    try {
      await oldWriter.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await oldWriter.beginTransaction()
      assert.equal((await oldWriter.query("SELECT status FROM accounting_runtime_modes WHERE book='commerce-v2'"))[0][0].status, 'active')
      await restored.query("UPDATE accounting_runtime_modes SET status='retired' WHERE book='commerce-v2'")
      assert.equal((await oldWriter.query("SELECT status FROM accounting_runtime_modes WHERE book='commerce-v2'"))[0][0].status, 'active')
      await assert.rejects(oldWriter.query("INSERT INTO accounting_requests(book,id,wallet_id,state,source,updated_at,payload) VALUES ('commerce-v2','stale-writer-bypass','resources-root','running','custom',1,'{}')"), /ACCOUNTING_BOOK_RETIRED/)
    } finally { await oldWriter.rollback(); oldWriter.release() }
    await assertAccountingRuntime(restored, false)
    return true
  } finally {
    await Promise.all([source?.end(), restored?.end()])
    if (created) { assert.match(destination, /^yushu_retirement_restore_[a-f0-9]{10}$/); await admin.query('DROP DATABASE ??', [destination]) }
    await admin.end()
  }
}
