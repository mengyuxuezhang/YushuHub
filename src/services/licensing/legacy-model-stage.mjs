import { memoryStateStore, LICENSING_SCHEMA } from '../../repositories/licensing-state.mjs'
import { customDefinitionService } from './custom-definitions.mjs'
import { createAgentCommerce, emptyCommerceState } from './commerce.mjs'
import { offerFor, offerKey } from './offer-pricing.mjs'
import { managedCustomModels } from './managed-custom-models.mjs'
import { identifier, failure } from './protocol.mjs'
import { migrationHash } from './legacy-import.mjs'
import { verifyLegacyImportReceipt } from './local-legacy-binding.mjs'
import { reviewLegacyModels } from './legacy-model-review.mjs'

const definitionsBook = 'commerce-v2-custom-definitions', receiptBook = 'legacy-model-stages-v1'
const decode = value => typeof value === 'string' ? JSON.parse(value) : value
const allowed = ['sourcePlanId', 'adapter', 'contextWindow', 'maxOutputTokens', 'supportsStreaming', 'maxImages', 'allowedVoiceIds']
const denied = () => { throw failure('STAGE_EXECUTION_FORBIDDEN', '报价暂存不能调用供应商或修改用户账务', 409) }

// Run the actual definition/offer validators against isolated drafts. No new
// pricing implementation and no temporary enabling of a migrated model.
export async function prepareLegacyModelStage(review, input, { root, definitions, offers, fileIds, managed, actor, now = Date.now() }) {
  identifier(actor)
  if (input?.modelPreviewDigest !== review.previewDigest) throw failure('MODEL_PREVIEW_CHANGED', '报价预览已变化，请重新审核', 409)
  const candidates = review.models.filter(row => row.proposal)
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 1000 || input.items.length !== candidates.length
    || input.items.some(row => !row || Object.keys(row).some(key => !allowed.includes(key)))
    || new Set(input.items.map(row => row.sourcePlanId)).size !== input.items.length
    || new Set(candidates.map(row => row.modelId)).size !== candidates.length
    || input.items.some(row => !candidates.some(candidate => candidate.sourcePlanId === row.sourcePlanId))) {
    throw failure('INVALID_MODEL_STAGE', '须逐项填写全部可暂存方案；同一模型多任务须先适配，不能覆盖或遗漏', 409)
  }
  if (Object.keys(input).some(key => !['modelPreviewDigest', 'items'].includes(key))) throw failure('INVALID_MODEL_STAGE', '报价暂存参数不允许覆盖价格、连接或状态')
  const definitionStore = memoryStateStore(definitions), offerStore = memoryStateStore({ ...emptyCommerceState(), offers })
  const service = customDefinitionService({ store: definitionStore, managed, fileIds, now: () => now }), staged = []
  const commerce = createAgentCommerce({ store: offerStore, rootId: root.id, now: () => now,
    catalog: async () => (await service.definitions(root.id)).map(definition => ({ ...definition, source: 'custom' })),
    userBank: { settle: denied, reserve: denied }, invoke: denied, lookup: denied })
  for (const item of input.items) {
    const candidate = candidates.find(row => row.sourcePlanId === item.sourcePlanId), proposal = candidate.proposal
    if (definitions.roots[root.id]?.[candidate.modelId] || offerFor({ offers }, root.id, candidate.modelId)) throw failure('MODEL_STAGE_CONFLICT', '已有定义或报价须由正常版本化界面核对，不覆盖经营配置', 409)
    const { sourcePlanId, ...bounds } = item
    const saved = await service.save(root, { ...bounds, providerModelId: candidate.modelId, clientId: candidate.clientId,
      status: 'disabled', currency: 'CNY', costComponents: proposal.supplierCost.components, memo: proposal.costReview, expectedRevision: 0 }, actor)
    if (saved.definition.taskType !== proposal.taskType) throw failure('MODEL_STAGE_TASK_MISMATCH', '适配器与原任务不一致', 409)
    // Resolve without credentials: checks the original organization/model,
    // HTTPS endpoint and capacity, but never decrypts a Key or sends a request.
    await managed.resolve(saved.definition, root)
    const offer = await commerce.configure(root, { modelId: candidate.modelId, enabled: false, expectedVersion: 0,
      pointsPerCny: proposal.pointsPerCny, consumptionMultiplier: proposal.consumptionMultiplier,
      saleMarkup: proposal.saleMarkup, supplyMarkup: proposal.saleMarkup }, actor)
    staged.push({ modelId: candidate.modelId, sourcePlanId, definitionVersion: saved.revision, offerVersion: offer.version,
      definitionEnabled: false, offerEnabled: false })
  }
  return { definitions: await definitionStore.read(), offers: (await offerStore.read()).offers, staged }
}

// Explicit maintenance tool only. Reuses the runtime configuration lock and
// commits definitions, disabled offers and the immutable batch receipt together.
export async function stageLegacyModels({ pool, snapshot, mapping, result, publicKeys, reviews, input, maintenance, fileIds, actor, now = Date.now() }) {
  if (!maintenance) throw failure('MAINTENANCE_REQUIRED', '停止经营写入并声明维护状态后再暂存', 409)
  if (!Array.isArray(fileIds) || fileIds.some(id => typeof id !== 'string')) throw failure('FILE_MODEL_REVIEW_REQUIRED', '须显式核对部署中的受控文件模型')
  identifier(actor)
  const claims = verifyLegacyImportReceipt(result, { snapshot, mapping, publicKeys, now })
  if (result.grant.level !== 1 || result.grant.modelMode !== 'custom') throw failure('MODEL_FIXED', '仅自定义一级可暂存自接模型', 403)
  const fingerprint = migrationHash({ receiptHash: claims.receiptHash, reviews, input, fileIds, actor })
  await pool.query(LICENSING_SCHEMA)
  await pool.query('INSERT IGNORE INTO licensing_state(id,document) VALUES (?,?)', [receiptBook, JSON.stringify({ receipts: {} })])
  const connection = await pool.getConnection()
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await connection.beginTransaction()
    const [[receiptRow]] = await connection.query('SELECT document FROM licensing_state WHERE id=? FOR UPDATE', [receiptBook])
    const receipts = decode(receiptRow.document), previous = receipts.receipts[claims.batchId]
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '暂存批次已用于其他配置', 409)
      await connection.rollback(); return { ...previous, alreadyApplied: true }
    }
    const [[organization]] = await connection.query('SELECT external_id,agent_level FROM ai_organizations WHERE id=? FOR UPDATE', [mapping.oldOrganizationId])
    if (organization?.external_id !== claims.grantId || organization.agent_level !== 1) throw failure('BINDING_MISMATCH', '先完成原组织中心身份绑定', 409)
    const [[book]] = await connection.query("SELECT kind FROM accounting_books WHERE book='commerce-v2'")
    if (book?.kind !== 'commerce') throw failure('ACCOUNTING_NOT_READY', '须先显式初始化新账务配置，工具不会切换运行模式', 503)
    const [[definitionRow]] = await connection.query('SELECT document FROM licensing_state WHERE id=? FOR UPDATE', [definitionsBook])
    if (!definitionRow) throw failure('ACCOUNTING_NOT_READY', '供货定义尚未初始化', 503)
    await connection.query("INSERT INTO accounting_locks(book,resource) VALUES ('commerce-v2','configuration') ON DUPLICATE KEY UPDATE resource=VALUES(resource)")
    await connection.query("SELECT resource FROM accounting_locks WHERE book='commerce-v2' AND resource='configuration' FOR UPDATE")
    const [settings] = await connection.query("SELECT id,payload FROM accounting_settings WHERE book='commerce-v2' AND section='offers'")
    const offers = Object.fromEntries(settings.map(row => [row.id.slice('offers:'.length), decode(row.payload)]))
    const review = await reviewLegacyModels(connection, { snapshot, mapping, result, publicKeys, reviews })
    const staged = await prepareLegacyModelStage(review, input, { root: { id: claims.grantId, level: 1, modelMode: 'custom' },
      definitions: decode(definitionRow.document), offers, fileIds, actor, now,
      managed: managedCustomModels({ pool: connection, materializeKey: denied }) })
    await connection.query('UPDATE licensing_state SET document=?,revision=revision+1 WHERE id=?', [JSON.stringify(staged.definitions), definitionsBook])
    for (const row of staged.staged) {
      const key = offerKey({ offers: staged.offers }, claims.grantId, row.modelId)
      await connection.query("INSERT INTO accounting_settings(book,id,section,payload) VALUES ('commerce-v2',?,'offers',?)", [`offers:${key}`, JSON.stringify(staged.offers[key])])
    }
    const receipt = { schemaVersion: 1, batchId: claims.batchId, grantId: claims.grantId, fingerprint, modelPreviewDigest: review.previewDigest,
      snapshotHash: claims.snapshotHash, staged: staged.staged, blockers: review.blockers, actor, appliedAt: now,
      databaseChanged: true, runtimeModeChanged: false, cutoverReady: false, paidSupplierCalls: 0,
      remainingChecks: ['installed-runtime-shadow', 'official-model-mapping', 'single-writer-switch', 'rollback-rehearsal', 'seven-day-pilot'] }
    receipts.receipts[claims.batchId] = receipt
    await connection.query('UPDATE licensing_state SET document=?,revision=revision+1 WHERE id=?', [JSON.stringify(receipts), receiptBook])
    await connection.commit(); return { ...receipt, alreadyApplied: false }
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}
