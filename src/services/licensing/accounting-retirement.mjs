import { migrationHash } from './legacy-import.mjs'
import { collectMigrationProofs } from './migration-snapshot.mjs'
import { verifyLegacyImportReceipt } from './local-legacy-binding.mjs'
import { initialRetirementState, readAccountingRetirement, retirementStateId } from './accounting-retirement-state.mjs'
import { identifier, failure } from './protocol.mjs'
import { reviseOffer } from './offer-pricing.mjs'
import { migrateSupplyVoiceSchema } from '../../repositories/supply-voices.mjs'

const book = 'commerce-v2'
const tables = ['wallets', 'requests', 'holds', 'entries', 'settlements', 'commands', 'outbox', 'settings'].map(name => `accounting_${name}`)
const cashTables = ['ai_payment_refunds', 'ai_payment_refund_events']
const voiceTables = ['resources', 'jobs', 'artifacts', 'routing', 'slots'].map(name => `supply_voice_${name}`)
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const normalized = value => value.replace(/\s|`/g, '').toLowerCase()
function fences() {
  return [...tables, ...cashTables, ...voiceTables, 'licensing_state'].flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(event => {
    const name = `ai_retire_${table.replace(/^accounting_/, '').replace(/^ai_payment_/, 'cash_')}_${event[0].toLowerCase()}`
    const column = table === 'licensing_state' ? 'id' : 'book', value = table === 'licensing_state' ? 'local-resources-v1' : book
    const condition = cashTables.includes(table) ? 'TRUE' : event === 'UPDATE' ? `(OLD.${column}='${value}' OR NEW.${column}='${value}')` : `${event === 'DELETE' ? 'OLD' : 'NEW'}.${column}='${value}'`
    // Locking reads observe the current marker, even in an older writer's RR
    // transaction. They also drain in-flight monetary writes before retirement.
    const body = `BEGIN DECLARE retirement_status VARCHAR(16) DEFAULT NULL;
      IF ${condition} THEN
        SELECT status INTO retirement_status FROM accounting_runtime_modes WHERE book='${book}' LOCK IN SHARE MODE;
        IF retirement_status IS NULL OR retirement_status<>'active' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ACCOUNTING_BOOK_RETIRED'; END IF;
      END IF; END`
    return { name, table, event, body }
  }))
}
async function installFences(pool) {
  await pool.query('INSERT IGNORE INTO licensing_state(id,document) VALUES (?,?)', [retirementStateId, JSON.stringify(initialRetirementState())])
  const state = await readAccountingRetirement(pool)
  await pool.query("CREATE TABLE IF NOT EXISTS accounting_runtime_modes (book VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,status VARCHAR(16) NOT NULL) ENGINE=InnoDB")
  await pool.query('INSERT IGNORE INTO accounting_runtime_modes(book,status) VALUES (?,?)', [book, state.status])
  const [[mode]] = await pool.query('SELECT status FROM accounting_runtime_modes WHERE book=?', [book])
  if (mode?.status !== state.status) throw failure('RETIREMENT_FENCE_CONFLICT', '退役标记与SQL保护不一致', 409)
  await migrateSupplyVoiceSchema(pool)
  for (const fence of fences()) {
    const [[saved]] = await pool.query('SELECT ACTION_STATEMENT AS body,EVENT_OBJECT_TABLE AS target,EVENT_MANIPULATION AS event FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?', [fence.name])
    if (saved) {
      if (saved.target !== fence.table || saved.event !== fence.event || normalized(saved.body) !== normalized(fence.body)) throw failure('RETIREMENT_FENCE_CONFLICT', '数据库已有不同的退役保护，停止操作', 409)
    } else await pool.query(`CREATE TRIGGER ${fence.name} BEFORE ${fence.event} ON ${fence.table} FOR EACH ROW ${fence.body}`)
  }
}
async function inspect(connection, { snapshot, mapping, result, publicKeys, action }) {
  const claims = verifyLegacyImportReceipt(result, { snapshot, mapping, publicKeys })
  if (!['retire', 'resume'].includes(action)) throw failure('INVALID_RETIREMENT_ACTION', '退役操作无效')
  const [[organization]] = await connection.query('SELECT external_id,agent_level FROM ai_organizations WHERE id=?', [mapping.oldOrganizationId])
  if (organization?.external_id !== claims.grantId || Number(organization.agent_level) !== 1) throw failure('BINDING_MISMATCH', '原组织与中心绑定不一致', 409)
  const [[roots]] = await connection.query('SELECT COUNT(*) AS n FROM ai_organizations WHERE agent_level=1')
  if (Number(roots.n) !== 1) throw failure('BINDING_MISMATCH', '退役工具仅用于单一级部署库，先核对多主体数据', 409)
  const [[savedBook]] = await connection.query('SELECT kind FROM accounting_books WHERE book=?', [book])
  if (savedBook?.kind !== 'commerce') throw failure('ACCOUNTING_NOT_READY', '本地新账务未初始化', 409)
  const state = await readAccountingRetirement(connection)
  const counts = {}
  for (const table of tables.filter(table => table !== 'accounting_settings')) {
    const [[row]] = await connection.query(`SELECT COUNT(*) AS n FROM ${table} WHERE book=?`, [book]); counts[table] = Number(row.n)
  }
  for (const table of cashTables) { const [[row]] = await connection.query(`SELECT COUNT(*) AS n FROM ${table}`); counts[table] = Number(row.n) }
  for (const table of voiceTables) {
    const [[exists]] = await connection.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?', [table])
    if (Number(exists.n)) { const [[row]] = await connection.query(`SELECT COUNT(*) AS n FROM ${table} WHERE book=?`, [book]); counts[table] = Number(row.n) }
    else counts[table] = 0
  }
  const [[wallets]] = await connection.query('SELECT COUNT(*) AS n FROM accounting_wallets WHERE book=? AND (balance<>0 OR reserved<>0)', [book])
  const [[children]] = await connection.query('SELECT COUNT(*) AS n FROM ai_organizations WHERE agent_level=2')
  const pendingLegacyWork = {}
  for (const [table, field, states] of [['ai_builds', 'status', ['queued', 'running']], ['ai_model_operations', 'status', ['pending', 'running', 'outcome_unknown']], ['ai_voice_operations', 'status', ['pending', 'running', 'outcome_unknown']]]) {
    const [[row]] = await connection.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${field} IN (?)`, [states]); pendingLegacyWork[table] = Number(row.n)
  }
  const proofs = await collectMigrationProofs(connection)
  const [offers] = await connection.query("SELECT id,payload FROM accounting_settings WHERE book=? AND section='offers' ORDER BY id", [book])
  const [[definitions]] = await connection.query("SELECT document FROM licensing_state WHERE id='commerce-v2-custom-definitions'")
  const [[resourceState]] = await connection.query("SELECT document FROM licensing_state WHERE id='local-resources-v1'")
  const resourceIntents = resourceState ? Object.keys(parse(resourceState.document).intents || {}).length : 0
  const blockers = []
  if (Number(children.n)) blockers.push('SECONDARY_ORGANIZATIONS_PRESENT')
  if ((action === 'retire' && state.status !== 'active') || (action === 'resume' && state.status !== 'retired')) blockers.push('RUNTIME_STATE_MISMATCH')
  if (Object.entries(counts).some(([table, count]) => table !== 'accounting_wallets' && count > 0) || Number(wallets.n)) blockers.push('NEW_ACCOUNTING_HISTORY_PRESENT')
  if (Object.values(pendingLegacyWork).some(value => value !== 0)) blockers.push('LEGACY_WORK_PENDING')
  if (resourceIntents) blockers.push('NEW_RESOURCE_HISTORY_PRESENT')
  const payload = { schemaVersion: 1, action, batchId: claims.batchId, grantId: claims.grantId, authorizationVersion: claims.grantVersion, receiptHash: claims.receiptHash,
    stateVersion: state.version, runtimeStatus: state.status, counts, nonzeroWallets: Number(wallets.n), resourceIntents, secondaryOrganizations: Number(children.n), pendingLegacyWork,
    rightsHash: migrationHash(proofs), configurationHash: migrationHash({ offers: offers.map(row => ({ id: row.id, payload: parse(row.payload) })), definitions: definitions ? parse(definitions.document) : null }), blockers }
  return { ...payload, previewDigest: migrationHash(payload), databaseChanged: false, authorizesDatabaseRestore: false, cutoverReady: false }
}

export async function previewAccountingRetirement({ pool, ...input }) {
  const connection = await pool.getConnection()
  try { await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await connection.query('SET TRANSACTION READ ONLY'); await connection.beginTransaction()
    const report = await inspect(connection, input); await connection.commit(); return report
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}

export async function applyAccountingRetirement({ pool, maintenance, previewDigest, commandId, actor, ...input }) {
  if (!maintenance) throw failure('MAINTENANCE_REQUIRED', '停止本库全部业务进程并显式声明维护状态', 409)
  identifier(commandId); identifier(actor)
  const claims = verifyLegacyImportReceipt(input.result, input)
  const fingerprint = migrationHash({ action: input.action, commandId, actor, previewDigest, receiptHash: claims.receiptHash })
  const [grants] = await pool.query('SHOW GRANTS FOR CURRENT_USER()')
  if (!grants.some(row => Object.values(row).some(value => /\b(?:ALL PRIVILEGES|PROCESS)\b.*\bON\s+\*\.\*/i.test(String(value))))) throw failure('PROCESS_PRIVILEGE_REQUIRED', '退役工具需显式全局PROCESS权限检查本库其他连接', 403)
  const cached = state => {
    const previous = state.receipts[commandId]
    if (!previous) return null
    if (previous.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '操作编号已用于不同退役指令', 409)
    return { ...previous, alreadyApplied: true, currentStatus: state.status, currentVersion: state.version }
  }
  const previous = cached(await readAccountingRetirement(pool))
  if (previous) return previous
  const [[initialPeers]] = await pool.query('SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()')
  if (Number(initialPeers.n)) throw failure('BUSINESS_CONNECTIONS_PRESENT', '本库仍有其他连接，请停止业务进程及其他数据库工具', 409)
  const initialPreview = await previewAccountingRetirement({ pool, ...input })
  if (initialPreview.previewDigest !== previewDigest) throw failure('RETIREMENT_PREVIEW_CHANGED', '权益、配置、任务或运行状态已变化，重新预览', 409)
  if (initialPreview.blockers.length) throw failure('RETIREMENT_BLOCKED', '存在新账务记录、待处理任务或状态冲突，禁止退役/恢复', 409)
  // DDL is explicit, outside the business transaction. Active fences permit
  // normal operation; partial installation never grants permission to retire.
  await installFences(pool)
  const connection = await pool.getConnection()
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await connection.beginTransaction()
    // Same ordering as configuration writers: configuration, then marker.
    await connection.query("INSERT INTO accounting_locks(book,resource) VALUES (?,'configuration') ON DUPLICATE KEY UPDATE resource=VALUES(resource)", [book])
    await connection.query("SELECT resource FROM accounting_locks WHERE book=? AND resource='configuration' FOR UPDATE", [book])
    await connection.query('SELECT status FROM accounting_runtime_modes WHERE book=? FOR UPDATE', [book])
    const state = await readAccountingRetirement(connection, { lock: true }), committed = cached(state)
    if (committed) { await connection.rollback(); return committed }
    const [[peers]] = await connection.query('SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()')
    if (Number(peers.n)) throw failure('BUSINESS_CONNECTIONS_PRESENT', '本库仍有其他连接，请停止业务进程及其他数据库工具', 409)
    const preview = await inspect(connection, input)
    if (preview.previewDigest !== previewDigest) throw failure('RETIREMENT_PREVIEW_CHANGED', '权益、配置、任务或运行状态已变化，重新预览', 409)
    if (preview.blockers.length) throw failure('RETIREMENT_BLOCKED', '存在新账务记录、待处理任务或状态冲突，禁止退役/恢复', 409)
    state.status = input.action === 'retire' ? 'retired' : 'active'; state.version++
    // Own transaction sees this active marker; other writers remain blocked on
    // its row until all offers have been disabled and the receipt has committed.
    await connection.query('UPDATE accounting_runtime_modes SET status=? WHERE book=?', [state.status, book])
    await connection.query('UPDATE licensing_state SET document=?,revision=revision+1 WHERE id=?', [JSON.stringify(state), retirementStateId])
    let disabledOffers = 0
    if (input.action === 'resume') {
      const [offers] = await connection.query("SELECT id,payload FROM accounting_settings WHERE book=? AND section='offers' FOR UPDATE", [book])
      for (const row of offers) {
        const offer = parse(row.payload)
        if (!offer.enabled) continue
        const { version, actor: previousActor, at, history, priceEffectiveAt, previousPrice, ...fields } = offer
        const disabled = reviseOffer(offer, { ...fields, enabled: false }, actor, Date.now())
        await connection.query('UPDATE accounting_settings SET payload=? WHERE book=? AND id=?', [JSON.stringify(disabled), book, row.id]); disabledOffers++
      }
    }
    const rightsHashAfter = migrationHash(await collectMigrationProofs(connection))
    if (rightsHashAfter !== preview.rightsHash) throw failure('RETIREMENT_RIGHTS_CHANGED', '维护期间原业务数据发生变化，停止切换并重新核对', 409)
    const receipt = { schemaVersion: 1, commandId, fingerprint, action: input.action, actor, at: Date.now(), version: state.version, status: state.status,
      grantId: claims.grantId, authorizationVersion: claims.grantVersion, previewDigest, rightsHash: preview.rightsHash, configurationHashBefore: preview.configurationHash,
      rightsHashAfter, disabledOffers, financialRecordsChanged: false, databaseSnapshotRestored: false, cutoverReady: false }
    state.receipts[commandId] = receipt
    await connection.query('UPDATE licensing_state SET document=?,revision=revision+1 WHERE id=?', [JSON.stringify(state), retirementStateId])
    await connection.commit(); return { ...receipt, alreadyApplied: false }
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}
