import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { mysqlAccountingStore, canonicalAccounting } from '../src/repositories/accounting.mjs'
import { collectMigrationProofs } from '../src/services/licensing/migration-snapshot.mjs'

// Opt-in fixture for disposable HTTP acceptance only. Never installs a package,
// restores a database or decides which version is safe for a deployment.
export async function readRuntimeVersionFixture(filename, currentRoot) {
  if (!filename) return null
  const input = JSON.parse(await fs.readFile(filename, 'utf8'))
  const fixture = {}
  for (const key of ['current', 'compatible']) {
    const item = input[key]
    assert(item && path.isAbsolute(item.root), 'Absolute isolated source directory required')
    assert.match(item.version, /^\d+\.\d+\.\d+-acceptance\.\d+$/)
    const root = await fs.realpath(item.root)
    assert.notEqual(root, await fs.realpath(currentRoot), 'Use isolated versioned copies')
    assert.equal(await fs.access(path.join(root, '.env')).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error
      return false
    }), false, 'Versioned TEST copies must not contain deployment .env files')
    const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    assert.equal(packageJson.version, item.version)
    const server = await fs.readFile(path.join(root, 'cloud/ai-admin/server.mjs'))
    fixture[key] = { root, version: item.version, entrySha256: createHash('sha256').update(server).digest('hex') }
  }
  assert.notEqual(fixture.current.root, fixture.compatible.root)
  assert.notEqual(fixture.current.version, fixture.compatible.version)
  assert.notEqual(fixture.current.entrySha256, fixture.compatible.entrySha256, 'Distinct code versions required, not metadata-only fixtures')
  const current = fixture.current.version.split('-acceptance.')
  const previous = fixture.compatible.version.split('-acceptance.')
  assert.equal(current[0], previous[0])
  assert(Number(previous[1]) < Number(current[1]), 'Compatible fixture must be an earlier acceptance version')
  return fixture
}

export async function verifyRuntimeVersionRehearsal({ fixture, pool, stop, start, rejectLegacy, runtimeInfo, replay }) {
  if (!fixture) return null
  const [[database]] = await pool.query('SELECT DATABASE() AS name')
  assert.match(database.name, /^yushu_resources_local_[a-f0-9]{10}$/)
  async function snapshot() {
    const state = await mysqlAccountingStore(pool, 'commerce-v2', 'commerce').read()
    assert(Object.keys(state.requests).length > 0, 'Post-settlement fixture required')
    // Outbox retry timing and SQL lock rows are operational state, not money.
    const { outbox, ...money } = state
    const rows = {}
    for (const table of ['accounting_holds', 'accounting_settlements']) {
      rows[table] = (await pool.query(`SELECT * FROM ${table} WHERE book='commerce-v2'`))[0]
        .map(canonicalAccounting).sort()
    }
    return canonicalAccounting({ money, rows, rights: await collectMigrationProofs(pool) })
  }
  assert.equal((await runtimeInfo()).version, fixture.current.version)
  const before = await snapshot()
  const first = await replay()
  assert.equal(await snapshot(), before, 'Initial replay must be idempotent')
  for (const version of [fixture.compatible, fixture.current]) {
    // stop must await the actual child exit; start independently rejects a live
    // writer. The same database and deployment files are kept throughout.
    await stop()
    await rejectLegacy(version.root)
    await start(version.root)
    assert.equal((await runtimeInfo()).version, version.version)
    assert.equal((await replay()).entry.id, first.entry.id)
    assert.equal(await snapshot(), before, 'Version transition changed money or rights')
  }
  return { currentVersion: fixture.current.version, compatibleVersion: fixture.compatible.version,
    currentEntrySha256: fixture.current.entrySha256, compatibleEntrySha256: fixture.compatible.entrySha256,
    stoppedWriterBeforeEachStart: true, postSettlementMoneyAndRightsPreserved: true,
    originalRefundReplayNoDuplicate: true, returnedToCurrentVersion: true,
    legacyModeStartupRejectedAfterSettlement: true,
    databaseSnapshotRestored: false, productionChanged: false }
}
