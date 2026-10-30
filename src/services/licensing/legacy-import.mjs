import { digest, domain, failure, identifier } from './protocol.mjs'

const retired = new Set(['center_suppliers.manage', 'organizations.capabilities.manage'])
const secretFields = /password|secret|credential|api_?key|token/i
export function canonicalMigration(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalMigration).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalMigration(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const migrationHash = value => digest(canonicalMigration(value))
function noSecrets(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (secretFields.test(key)) throw failure('SECRET_IN_SNAPSHOT', '迁入快照不得包含旧Token、密码或密钥')
    noSecrets(item)
  }
}
const reason = value => typeof value === 'string' && value.trim().length >= 3 && value.length <= 500
const count = value => Number.isSafeInteger(value) && value >= 0
const same = (a, b) => canonicalMigration(a) === canonicalMigration(b)

// One local deployment per manifest. Historical secondary/cross-first moves
// remain deferred; new secondary activation is independent of this importer.
export function prepareLegacyImport(state, input) {
  noSecrets(input.snapshot)
  noSecrets(input.mapping)
  const snapshot = input.snapshot, mapping = input.mapping
  if (snapshot?.schemaVersion !== 1 || !mapping || !Array.isArray(snapshot.organizations) || snapshot.organizations.length !== 1) throw failure('INVALID_IMPORT', '每份迁入快照须明确对应一个一级部署')
  const sourceId = identifier(snapshot.sourceId), batchId = identifier(input.batchId), old = snapshot.organizations[0]
  if (old.agentLevel !== 1) throw failure('HISTORICAL_SECONDARY_DEFERRED', '存量二级迁移不在当前导入范围，不能自动丢弃或转绑')
  identifier(old.id)
  if (mapping.oldOrganizationId !== old.id) throw failure('BINDING_MISMATCH', '审核映射与原组织不一致', 409)
  const id = identifier(mapping.grantId), instanceId = identifier(mapping.instanceId), origin = domain(mapping.domain)
  if (id.length > 64 || typeof old.name !== 'string' || !old.name.trim() || old.name.length > 120 || typeof old.allowCustomApiProviders !== 'boolean') throw failure('INVALID_IMPORT', '迁入代理名称、模型模式或标识无效')
  if (old.legacySupplierId && old.legacySupplierId !== id) throw failure('SUPPLIER_ID_MAPPING_REQUIRED', '首版须保留旧官方供应商ID，避免构建和保护资源失去归属', 409)
  if ((old.instanceId && old.instanceId !== instanceId) || (old.domain && domain(old.domain) !== origin)) throw failure('BINDING_MISMATCH', '历史实例/域名发生变化，应先完成独立换机审核', 409)
  if ((!old.instanceId || !old.domain) && !reason(mapping.bindingReview)) throw failure('BINDING_REVIEW_REQUIRED', '历史部署缺少绑定，须填写核验依据')
  if (!['enabled', 'disabled', 'suspended', 'revoked'].includes(old.status)) throw failure('INVALID_STATUS', '历史状态须明确核对，不能默认启用')
  if (old.expiresAt !== null && (typeof old.expiresAt !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(old.expiresAt) || !Number.isFinite(Date.parse(old.expiresAt)))) throw failure('INVALID_EXPIRY', '历史期限须为带时区时间或明确null')
  if (old.expiresAt === null && !reason(mapping.unlimitedExpiryReview)) throw failure('UNLIMITED_REVIEW_REQUIRED', '历史无限期限须显式核验')
  const pkg = state.packages[`${identifier(mapping.packageId)}:${mapping.packageVersion}`]
  const known = new Set(Object.values(state.packages).flatMap(item => item.capabilities.map(cap => cap.key)))
  if (!pkg || pkg.level !== 1 || pkg.modelMode !== (old.allowCustomApiProviders ? 'custom' : 'fixed')) throw failure('INVALID_PACKAGE', '迁入套餐须保持原一级层级及模型模式')
  if (!Array.isArray(snapshot.capabilities) || snapshot.capabilities.some(cap => cap.organizationId !== old.id || typeof cap.enabled !== 'boolean' || !count(cap.limitValue))) throw failure('INVALID_CAPABILITIES', '历史能力和额度须显式归属原组织')
  const enabled = snapshot.capabilities.filter(cap => cap.enabled), wildcard = enabled.some(cap => cap.key === '*')
  if (new Set(snapshot.capabilities.map(cap => cap.key)).size !== snapshot.capabilities.length) throw failure('DUPLICATE_CAPABILITY', '历史能力重复')
  if (wildcard && (!reason(mapping.wildcardReview) || !Array.isArray(mapping.resolvedCapabilities) || mapping.resolvedCapabilities.includes('*'))) throw failure('WILDCARD_REVIEW_REQUIRED', '通配授权须逐能力核验后列出')
  const before = [...new Set(wildcard ? mapping.resolvedCapabilities : enabled.map(cap => cap.key))]
  if (before.some(key => !known.has(key) && !retired.has(key))) throw failure('UNKNOWN_CAPABILITY', '历史能力含未映射项，不能静默删除')
  const retained = before.filter(key => !retired.has(key)).sort(), after = pkg.capabilities.filter(cap => cap.enabled).map(cap => cap.key).sort()
  if (retained.some(key => !after.includes(key))) throw failure('CAPABILITY_LOSS', '套餐缺少历史能力，只有转授权能力按新规则退役', 409)
  const additions = after.filter(key => !retained.includes(key)), approvals = mapping.additionalCapabilities || []
  if (!Array.isArray(approvals) || new Set(approvals.map(item => item.key)).size !== approvals.length || approvals.some(item => !additions.includes(item.key) || !reason(item.reason)) || additions.some(key => !approvals.some(item => item.key === key))) throw failure('CAPABILITY_EXPANSION_REVIEW_REQUIRED', '新增能力须逐项明确批准，不能套用全权限模板')
  const projects = snapshot.projects, builds = snapshot.builds
  if (!Array.isArray(projects) || !Array.isArray(builds)) throw failure('RESOURCE_INVENTORY_REQUIRED', '须提供全部有效项目和已保留构建ID')
  for (const rows of [projects, builds]) {
    const ids = rows.map(row => identifier(row.id))
    if (new Set(ids).size !== ids.length || rows.some(row => row.organizationId !== old.id)) throw failure('RESOURCE_OWNER_CONFLICT', '资源重复或不属于原组织', 409)
  }
  if (!count(old.usage?.projects) || old.usage.projects !== projects.length || !count(old.usage?.builds) || old.usage.builds < builds.length) throw failure('USAGE_BASELINE_REQUIRED', '项目须有完整ID，构建累计数不能低于保留记录')
  const quotaChanges = [], overQuota = []
  for (const [kind, permission] of [['projects', 'projects.manage'], ['builds', 'builds.create']]) {
    const previous = snapshot.capabilities.find(cap => cap.key === permission && cap.enabled), target = pkg.quotas[kind]
    const oldQuota = previous ? previous.limitValue === 0 ? null : { mode: 'limited', value: previous.limitValue } : wildcard ? null : { mode: 'none' }
    if (!oldQuota || !same(oldQuota, target)) {
      const review = mapping.quotaReviews?.[kind]
      if (!review || !same(review.quota, target) || !reason(review.reason)) throw failure('QUOTA_REVIEW_REQUIRED', '旧0值/变更额度须明确核定为未授权、有限或无限')
      quotaChanges.push({ kind, before: oldQuota || 'ambiguous-zero', after: target, reason: review.reason })
    }
    if (old.usage[kind] > 0 && (target.mode === 'none' || (target.mode === 'limited' && old.usage[kind] > target.value))) overQuota.push({ kind, used: old.usage[kind], quota: target })
  }
  if (overQuota.length && !reason(mapping.overQuotaReview)) throw failure('OVER_QUOTA_REVIEW_REQUIRED', '历史超额须保留并人工核验，不能清零后导入')
  const proofs = snapshot.proofs
  for (const group of ['users', 'balances', 'memberships', 'orders', 'ledger', 'modelAccess', 'modelPrices', 'projects', 'builds']) if (!count(proofs?.[group]?.count) || !/^[a-f0-9]{64}$/.test(proofs[group].hash)) throw failure('RIGHTS_PROOF_REQUIRED', '须提供用户权益、价格、资源和历史流水核对摘要')
  if (proofs.projects.count !== projects.length || proofs.builds.count !== builds.length) throw failure('RESOURCE_PROOF_MISMATCH', '资源清单与原记录核对数量不一致')
  if (!Array.isArray(mapping.officialModelIds)) throw failure('MODEL_SCOPE_REVIEW_REQUIRED', '须显式核定官方模型目录；自接模型不自动转换为官方模型')
  const modelIds = [...new Set(mapping.officialModelIds.map(model => identifier(model)))]
  if (modelIds.length && !reason(mapping.modelScopeReview)) throw failure('MODEL_SCOPE_REVIEW_REQUIRED', '官方供货模型须记录核定依据')
  if (!Number.isSafeInteger(snapshot.capturedAt) || snapshot.capturedAt <= 0) throw failure('INVALID_SNAPSHOT', '快照采集时间无效')
  const snapshotHash = migrationHash(snapshot), fingerprint = migrationHash({ snapshot, mapping, batchId })
  const previous = state.legacyImports?.[batchId]
  if (previous && previous.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '迁入批次已用于其他快照或映射', 409)
  if (!previous && (Object.keys(state.grants).some(key => key.toLowerCase() === id.toLowerCase()) || Object.values(state.legacyImports || {}).some(item => item.sourceId === sourceId))) throw failure('IMPORT_ALREADY_EXISTS', '授权ID或原实例已经迁入，不能重复创建和重置额度', 409)
  const impact = { batchId, sourceId, snapshotHash, mappingHash: migrationHash(mapping), oldOrganizationId: old.id, grantId: id, packageId: pkg.id, packageVersion: pkg.version,
    retainedCapabilities: retained, removedDelegation: before.filter(key => retired.has(key)), addedCapabilities: approvals,
    domain: origin, instanceId, expiresAt: old.expiresAt, status: old.status === 'disabled' ? 'suspended' : old.status, quotas: pkg.quotas, quotaChanges, overQuota,
    preservedUsage: old.usage, identifiedProjects: projects.length, identifiedBuilds: builds.length, additionalHistoricalBuilds: old.usage.builds - builds.length,
    importedSupplyCredit: '0.000000', upstreamBalanceAction: 'unchanged-no-credit', proofs, officialModelIds: modelIds }
  return { impact, fingerprint, previous, previewDigest: migrationHash(impact),
    issue: { id, name: old.name, packageId: pkg.id, packageVersion: pkg.version, domain: origin, expiresAt: old.expiresAt, modelIds }, projects, builds }
}
