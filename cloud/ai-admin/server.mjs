import { normalizeModelProviderKey, listModelProviderKeys as listProviderKeys, saveModelProviderKey as saveProviderKey } from '../../src/services/model-provider-keys.mjs'
import { selectEligibleModelKeys, findKeyScopeModelId, resolveTaskModelKeyContext } from '../../src/services/model-key-scope.mjs'
import { createJsonRequestBodyParser } from '../../src/middleware/json-request-body.mjs'
import { queryModelProviders } from '../../src/repositories/model-providers.mjs'
import express from 'express'
import { normalizeLoginDesign, preserveSubmittedLoginBrandFields } from '../../src/services/login-brand.mjs'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import nodemailer from 'nodemailer'

import { disableDynamicResponseCaching } from '../../src/middleware/cache-control.mjs'
import { initDatabase } from '../../src/db/schema.mjs'
import { setPool, db } from '../../src/db/pool.mjs'
import { repoRoot, APP_LOG_DIR, APP_LOG_FILE, LEGACY_UPLOAD_DIR, UPLOAD_DIR, PUBLIC_UPDATE_ROOT, PUBLIC_PREVIEW_ROOT, SELF_UPDATE_WORK_DIR, CUSTOM_HOMEPAGE_ROOT, CUSTOM_HOMEPAGE_SITE_DIR, CUSTOM_HOMEPAGE_CONFIG_PATH, MODEL_CREDENTIAL_KEY_PATH, VOICE_ARTIFACT_ROOT, WEB_INDEX_PATH, ADMIN_V2_INDEX_PATH, SITE_INDEX_PATH } from '../../src/config/paths.mjs'
import {
  PORT, HOST, ADMIN_USER, ADMIN_PASSWORD, SUPER_ADMIN_ID, SUPER_ADMIN_USERNAME, BUILD_MODE, WORKER_TOKEN, WORKER_PRIORITY, WORKER_DISABLED,
  PUBLIC_UPDATE_BASE_URL, PUBLIC_PREVIEW_BASE_URL, PUBLIC_ADMIN_BASE_URL, SOURCE_VERSION_URL,
  WINDOWS_ICON_MIN_SIZE, SELF_UPDATE_MANIFEST_URL, SELF_UPDATE_PM2_NAME, SELF_UPDATE_PM2_BIN, SELF_UPDATE_NPM_BIN, SELF_UPDATE_RESTART_DELAY_MS,
  BUILD_CENTER_URL, BUILD_CENTER_TOKEN, BUILD_CENTER_SUPPLIER_ID, BUILD_CENTER_PUBLIC_URL, CENTER_SUPPLIER_MANAGEMENT_ENABLED,
  BRAND_ASSET_IMAGE_BED_UPLOAD_URL, PACKAGE_VERSION, ADMIN_SESSION_COOKIE,
  DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME,
} from '../../src/config/env.mjs'
import { compareSemanticVersions, DESKTOP_NEXT_MIN_VERSION, isDesktopNextVersion } from '../../src/utils/version.mjs'
import {
  isSuperAdminUsername, isSuperAdminUser, defaultSupplierLicense,
  LOCAL_PERMISSION_CATALOG, DEFAULT_ROLE_TEMPLATES, defaultPlatformSettings,
} from '../../src/config/constants.mjs'
import { normalizeHttpUrl, normalizeOssEndpoint, trimSlashes, normalizeArtifactStorageMode, normalizeOssPublicBaseUrl, publicPathFromBaseUrl, normalizeSourceText } from '../../src/utils/normalize.mjs'
import { normalizeSecureBuildCenterUrl } from '../../src/utils/build-center-url.mjs'
import { canonicalizePublicUploadUrl } from '../../src/utils/public-url.mjs'
import { migrateOfficialUpdateDatabaseSettings, migrateOfficialUpdateEnvFile } from '../../src/services/official-update-source-migration.mjs'
import { readSelfUpdateRestartStatus, resolveCurrentPm2Process, scheduleVerifiedSelfRestart } from '../../src/services/self-update-runtime.mjs'
import { imageUsageEvents } from '../../src/services/media-billing.mjs'
import { mergeReleaseHistory, readReleaseHistory, readAdminReleaseHistory } from '../../src/services/release-history.mjs'
import { cleanupFailedBuildStorage } from '../../src/services/storage-retention.mjs'
import { migrateLegacyUploadStorage } from '../../src/services/upload-storage.mjs'
import { ensureWorkerStagingDirectory, normalizeExistingWorkerStagingDirectories } from '../../src/services/worker-staging-permissions.mjs'
import { hashPassword, verifyPassword, createSecretToken, hashSecretToken, normalizeRedeemCode, createRedeemCode } from '../../src/utils/crypto.mjs'
import { nowIso, toMysqlDateTime, parseOptionalDate, localDateString } from '../../src/utils/time.mjs'
import { slugify, safeProjectId, safeUsername, safeCenterId, safeEndUsername } from '../../src/utils/slug.mjs'
import { parseJson, parseLimit, parseFlag, parseCreditAmount, numberOrNull, pickFirstObject, stableStringify } from '../../src/utils/parse.mjs'
import { alternateHttpProtocolUrl, fetchText, fetchJson, readCookie } from '../../src/utils/http.mjs'
import { writeAppLog, tailTextFile, appendSelfUpdateLog, readSelfUpdateLog } from '../../src/utils/log.mjs'
import { redactPublicBuildLog } from '../../src/utils/build-log-redaction.mjs'
import { downloadFile, sha256File, copyDir, removeIfExists, runCommand, icoContainsSize, mimeFromAssetPath } from '../../src/utils/fs.mjs'
import {
  setAuthDependencies,
  canAccessProject,
  canOperateProject,
} from '../../src/middleware/auth.mjs'
import { setRedeemCodeDependencies, redeemCodeForEndUser } from '../../src/services/redeem-codes.mjs'
import {
  IMAGE_BILLING_TYPE,
  SYSTEM_IMAGE_PROVIDER,
  SYSTEM_IMAGE_MODEL,
  SYSTEM_IMAGE_PRICING,
  SYSTEM_AUDIO_PROVIDER_ID,
  SYSTEM_AUDIO_MODEL_ID,
  SYSTEM_AUDIO_ACCOUNT_ID,
  SYSTEM_AUDIO_PRICING_ID,
  isSystemImageRecordId,
  normalizeImageGenerationRequest,
  normalizeImageResolutionPoints,
  buildUpstreamImagePayload,
  normalizeImageGenerationResponse,
  calculateImageBillingPoints,
} from '../../src/services/image-generation.mjs'
import { migrateLegacySystemImageRecords } from '../../src/services/image-generation-migration.mjs'
import { registerRedeemCodeRoutes } from '../../src/routes/redeem-codes.mjs'
import { registerAuthRoutes } from '../../src/routes/auth.mjs'
import { registerSystemRoutes } from '../../src/routes/platform-settings.mjs'
import { registerClientApiRoutes } from '../../src/routes/client-api.mjs'
import { normalizeClientPolicy, clientProjectPolicy } from '../../src/services/client-project-policy.mjs'
import { registerClientProjectPolicyRoutes } from '../../src/routes/client-project-policy.mjs'
import { registerClientNoticeRoutes } from '../../src/routes/client-notices.mjs'
import { syncNoticesFromCenter } from '../../src/services/client-notice-federation.mjs'
import { registerModelServiceRoutes } from '../../src/routes/model-service.mjs'
import { registerVoiceConfigurationRoutes } from '../../src/routes/voice-configuration.mjs'
import { registerVoiceServiceRoutes } from '../../src/routes/voice-service.mjs'
import { registerPricingCenterRoutes } from '../../src/routes/pricing-center.mjs'
import { registerModelCapabilityRoutes } from '../../src/routes/model-capabilities.mjs'
import { registerModelTaskRoutes } from '../../src/routes/model-tasks.mjs'
import { registerUpstreamAccountRoutes } from '../../src/routes/upstream-accounts.mjs'
import { saveProviderModelRecord } from '../../src/services/provider-model-save.mjs'
import { VoiceConfigurationService } from '../../src/services/voice-configuration.mjs'
import { ModelCredentialVault } from '../../src/services/model-credentials.mjs'
import { VoiceModelContext } from '../../src/services/voice-model-context.mjs'
import { VoiceOperationRepository } from '../../src/repositories/voice-operations.mjs'
import { VoiceArtifactStore } from '../../src/services/voice-artifacts.mjs'
import { PrivateVoiceService } from '../../src/services/private-voices.mjs'
import { VoiceDeletionService } from '../../src/services/voice-deletion.mjs'
import { registerVoiceResourceRoutes } from '../../src/routes/voice-resources.mjs'
import { registerUserRoutes } from '../../src/routes/users.mjs'
import { registerUserUsageReportRoutes } from '../../src/routes/user-usage-report.mjs'
import { registerAdminBusinessRoutes } from '../../src/routes/admin-business.mjs'
import { registerBuildRoutes } from '../../src/routes/builds.mjs'
import { registerMembershipRoutes } from '../../src/routes/memberships.mjs'
import { registerPaymentRoutes } from '../../src/routes/payments.mjs'
import { registerCuratedSkillRoutes } from '../../src/routes/curated-skills.mjs'
import { registerCuratedMcpRoutes } from '../../src/routes/curated-mcps.mjs'
import { registerCuratedAgentRoutes } from '../../src/routes/curated-agents.mjs'
import { registerOrganizationRoutes } from '../../src/routes/organizations.mjs'
import { registerCustomHomepageRoutes } from '../../src/routes/custom-homepage.mjs'
import { ensureAccountFreeMembership, ensureFreeMembershipFallback, grantMembershipBenefits } from '../../src/services/memberships.mjs'
import { normalizeManualEndUserAccount } from '../../src/services/end-user-accounts.mjs'
import { cleanupRetiredBuiltinSkills } from '../../src/services/builtin-curated-skills.mjs'
import { createAccessControlPolicy } from '../../src/services/access-control.mjs'
import { createSupplierLicenseService } from '../../src/services/supplier-license.mjs'
import { deploymentRuntime, officialAuthorization } from '../../src/services/licensing/admin-runtime.mjs'
import { createClientAuthorization, officialServicePolicy } from '../../src/services/licensing/resource-access.mjs'
import { registerDeploymentAuthorizationRoutes } from '../../src/routes/deployment-authorization.mjs'
import { agentCommerceRuntime } from '../../src/services/licensing/commerce-runtime.mjs'
import { resourceRuntime, buildResourceIdentity, lockBuildProject, assertProjectUserRetention } from '../../src/services/licensing/resource-runtime.mjs'
import { officialResourceClient } from '../../src/services/licensing/official-resources.mjs'
import { centerBuildScopes, assertRecordedOrganization, officialCenterProjectId as centerProjectId } from '../../src/services/licensing/build-scopes.mjs'
import { ensureOfficialSupplierRegistration } from '../../src/services/licensing/official-registration.mjs'
import { assertAccountingRuntime } from '../../src/services/licensing/accounting-mode.mjs'
import { guardSupplyProviderConnection, guardSupplyProviderDeletion, guardSupplyModelConnection, guardSupplyModelDeletion } from '../../src/services/licensing/private-voice-binding.mjs'
import { registerAgentSupplyRoutes } from '../../src/routes/agent-supply.mjs'
import { supplierLicenseAllowsPermission } from '../../src/services/supplier-license-contract.mjs'
import { createCenterSupplierAuthorizationService, normalizeCenterSupplier } from '../../src/services/center-supplier-authorization.mjs'
import { downloadBuildArtifact } from '../../src/services/build-artifact-transfer.mjs'
import { buildOrganizationContext, normalizeDataScope } from '../../src/services/organizations.mjs'
import { filterOrganizationPermissions } from '../../src/services/organization-expiry.mjs'
import { assertOrganizationQuota } from '../../src/services/quota-guard.mjs'
import * as organizationRepository from '../../src/repositories/organizations.mjs'
import { applyClientUsageDebit, assertClientModelRequestAllowed, getClientCreditState } from '../../src/services/client-billing.mjs'
import { PricingPlanRepository } from '../../src/repositories/pricing-plans.mjs'
import { PricingPlanService } from '../../src/services/pricing-plans.mjs'
import { ModelCapabilityService } from '../../src/services/model-capability-service.mjs'
import { ProtocolManifestRegistry, BUILTIN_PROTOCOLS } from '../../src/services/model-invoke/protocol-manifest.mjs'
import { effectiveGatewayPricingRule, legacyPricingProjection, legacyRulePricingPlan, normalizeTokenUsage, quotePricing, tokenUsageEvents, usageEvent } from '../../src/services/compound-pricing.mjs'
import { ProtocolAdapterRegistry, ModelInvocationService } from '../../src/services/model-invoke/registry.mjs'
import { MockEmbeddingAdapter, MockVideoJobAdapter } from '../../src/services/model-invoke/mock-adapters.mjs'
import { ModelOperationRepository } from '../../src/repositories/model-operations.mjs'
import { ModelTaskService } from '../../src/services/model-task-service.mjs'
import { UpstreamAccountService } from '../../src/services/upstream-accounts.mjs'
import { ModelServiceV2Sync } from '../../src/services/model-service-v2-sync.mjs'
import { assertSupplierBuildQuota, normalizeSupplierProjectIds, planSupplierProjectReservation } from '../../src/services/supplier-quotas.mjs'
import { filterManagedWorkers, higherPriorityWorkerIds, isDelegatedBuildRecord, isIdleCompatibleWorker, isManagedWorkerId, isWorkerDisabled, MANAGED_WORKER_ID_LIST, parseWorkerPriority } from '../../src/services/worker-scheduling.mjs'
import { preserveConfiguredSecret, withEffectiveBuildCenterSettings } from '../../src/services/platform-secrets.mjs'
import { buildListSearch } from '../../src/services/list-search.mjs'
import { canManageBuiltinRoleTemplates } from '../../src/services/role-template-lifecycle.mjs'
import { remoteBuildMetadataPatch } from '../../src/services/build-record-sync.mjs'
import { resolveBuildBrandAssets } from '../../src/services/build-brand-assets.mjs'
import { startBuildCenterSyncScheduler } from '../../src/services/build-center-sync-scheduler.mjs'
import { isPaginationRequested, pageResult, parsePagination } from '../../src/utils/pagination.mjs'
import {
  buildSyncLookup,
  findMissingSyncItems,
  findSyncMatch,
  modelSyncBusinessKey,
  pricingSyncBusinessKey,
  shouldRetainMatchedSyncRow,
} from '../../src/services/model-service-sync.mjs'
import { resolveModelServiceScope, modelServiceScopeWhere, assertModelServiceRecordInScope } from '../../src/services/model-service-scope.mjs'
import {
  clientPricingPayload,
  normalizeConsumptionMultiplier,
  normalizePricingRulePrices,
  pricingRuleMultipliers,
} from '../../src/services/model-pricing.mjs'
import { normalizeModelReasoning } from '../../src/services/model-reasoning.mjs'
import { startMarketAutoSync } from '../../src/services/market-auto-sync.mjs'
import { createCustomHomepageService } from '../../src/services/custom-homepage.mjs'
import { createLoginProtectionService } from '../../src/services/login-protection.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const customHomepage = createCustomHomepageService({
  rootDir: CUSTOM_HOMEPAGE_ROOT,
  siteDir: CUSTOM_HOMEPAGE_SITE_DIR,
  configPath: CUSTOM_HOMEPAGE_CONFIG_PATH,
})
await customHomepage.initialize()
const sessions = new Map()
const loginProtection = createLoginProtectionService()
const accessControl = createAccessControlPolicy(LOCAL_PERMISSION_CATALOG)
let pool
let sourceVersionCache = { info: null, checkedAt: 0 }
let visibleSourceVersionCache = { info: null, checkedAt: 0 }
const localizingBuildIds = new Set()

app.use(createJsonRequestBodyParser())
app.use(express.urlencoded({ extended: true }))
app.use(disableDynamicResponseCaching)
app.use((req, res, next) => {
  const startedAt = Date.now()
  res.on('finish', () => {
    if (!req.path.startsWith('/api')) return
    writeAppLog('request', `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms ${req.ip || ''}`)
  })
  next()
})
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }))
app.use('/updates/ai', express.static(PUBLIC_UPDATE_ROOT, { maxAge: '5m' }))
app.use('/updates/ai-staging', express.static(PUBLIC_PREVIEW_ROOT, { maxAge: '5m' }))
app.use('/agent/ai', express.static(PUBLIC_UPDATE_ROOT, { maxAge: '5m' }))
app.use('/agent/ai-staging', express.static(PUBLIC_PREVIEW_ROOT, { maxAge: '5m' }))
app.use('/admin/static', express.static(path.dirname(WEB_INDEX_PATH), { maxAge: '1y', immutable: true }))
app.use('/admin/v2/assets', express.static(path.join(path.dirname(ADMIN_V2_INDEX_PATH), 'assets'), { maxAge: '1y', immutable: true }))
app.use('/site', express.static(path.dirname(SITE_INDEX_PATH), { maxAge: '5m' }))
app.use('/_custom-homepage', (_req, res, next) => {
  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  next()
}, express.static(CUSTOM_HOMEPAGE_SITE_DIR, {
  index: 'index.html',
  maxAge: '5m',
  dotfiles: 'ignore',
  setHeaders(res, filePath) {
    if (/\.html?$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store')
  },
}))
app.get('/_custom-homepage/*', (req, res, next) => {
  if (path.extname(req.path)) return next()
  res.sendFile(path.join(CUSTOM_HOMEPAGE_SITE_DIR, 'index.html'), (error) => {
    if (error) next()
  })
})

async function ensureStaticAliasForPublicUrl(baseUrl, targetRoot) {
  const publicPath = publicPathFromBaseUrl(baseUrl)
  if (!publicPath || publicPath === '/') return
  const aliasRoot = path.resolve(repoRoot, publicPath.replace(/^\/+/, ''))
  const target = path.resolve(targetRoot)
  if (aliasRoot === target) return
  const relative = path.relative(repoRoot, aliasRoot)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return

  try {
    const stat = await fsp.lstat(aliasRoot).catch(() => null)
    if (stat) {
      if (stat.isSymbolicLink()) {
        const linked = path.resolve(path.dirname(aliasRoot), await fsp.readlink(aliasRoot))
        if (linked !== target) {
          await fsp.rm(aliasRoot, { recursive: true, force: true })
        } else {
          return
        }
      } else {
        return
      }
    }
    await fsp.mkdir(path.dirname(aliasRoot), { recursive: true })
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
    await fsp.symlink(target, aliasRoot, symlinkType)
  } catch (err) {
    console.warn(`[ai-admin] unable to create static alias ${aliasRoot} -> ${target}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function ensurePublicStaticAliases() {
  await fsp.mkdir(PUBLIC_UPDATE_ROOT, { recursive: true })
  await fsp.mkdir(PUBLIC_PREVIEW_ROOT, { recursive: true })
  await ensureStaticAliasForPublicUrl(PUBLIC_UPDATE_BASE_URL, PUBLIC_UPDATE_ROOT)
  await ensureStaticAliasForPublicUrl(PUBLIC_PREVIEW_BASE_URL, PUBLIC_PREVIEW_ROOT)
}

function normalizeBuildCenterConfig(input = {}) {
  const url = normalizeSecureBuildCenterUrl(input.url || input.buildCenterUrl || '')
  const token = String(input.token || input.buildCenterToken || '').trim()
  const supplierIdRaw = String(input.supplierId || input.buildCenterSupplierId || '').trim()
  const supplierId = supplierIdRaw ? safeCenterId(supplierIdRaw, '供应商 ID') : ''
  return { url, token, supplierId, enabled: Boolean(url && (authorizationClient || (token && supplierId))) }
}

async function getBuildCenterConfig() {
  const settings = await getPlatformSettings('platform')
  return normalizeBuildCenterConfig({
    url: settings.buildCenterUrl || BUILD_CENTER_URL,
    token: settings.buildCenterToken || BUILD_CENTER_TOKEN,
    supplierId: settings.buildCenterSupplierId || BUILD_CENTER_SUPPLIER_ID,
  })
}

function buildCenterConfigCacheKey(config = {}) {
  return [
    String(config.url || ''),
    String(config.supplierId || ''),
    hashSecretToken(config.token || '').slice(0, 16),
  ].join('|')
}

async function buildCenterEnabled() {
  const config = await getBuildCenterConfig()
  return config.enabled
}

async function buildCenterApi(pathname, body = {}, config = null, organizationId = undefined) {
  const resolved = config || await getBuildCenterConfig()
  if (!resolved.enabled) throw new Error('官方构建中心未配置')
  if (authorizationClient && organizationId === undefined) {
    const groups = await centerBuildScopes(pathname, body, db(), organizationRepository.findOrganizationById)
    if (groups) {
      if (pathname === '/api/center/builds/status') return (await Promise.all(groups.map(group => buildCenterApi(pathname, { ...body, buildIds: group.buildIds }, resolved, group.grantId)))).flat()
      organizationId = groups[0].grantId
    }
  }
  const serviceToken = authorizationClient ? await authorizationClient.serviceToken(officialServicePolicy(pathname).audience, organizationId) : resolved.token
  const response = await fetch(`${resolved.url}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceToken}`,
    },
    body: JSON.stringify({ ...body, supplierId: body.supplierId || resolved.supplierId }),
    signal: AbortSignal.timeout(8000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.success === false) {
    throw Object.assign(new Error(data.error || data.message || `HTTP ${response.status}`), { statusCode: response.status, code: data.code })
  }
  return data.data
}

async function listLocalSupplierProjectIds(extraProjectId = '') {
  const [rows] = await db().query('SELECT id FROM ai_projects ORDER BY id')
  const values = rows.map((row) => row.id)
  if (extraProjectId) values.push(extraProjectId)
  return normalizeSupplierProjectIds(values)
}

async function reserveProjectQuotaAtCenter(projectId, existingProject = null) {
  if (authorizationClient) return false
  if (CENTER_SUPPLIER_MANAGEMENT_ENABLED || existingProject) return false
  const config = await getBuildCenterConfig()
  if (!config.enabled) return false
  await buildCenterApi('/api/center/projects/reserve', {
    projectId,
    projectIds: await listLocalSupplierProjectIds(projectId),
  }, config)
  resetSupplierLicenseCache()
  return true
}

async function releaseProjectQuotaAtCenter(projectId) {
  if (authorizationClient) return false
  if (CENTER_SUPPLIER_MANAGEMENT_ENABLED) return false
  const config = await getBuildCenterConfig()
  if (!config.enabled) return false
  const projectIds = (await listLocalSupplierProjectIds()).filter((id) => id !== projectId)
  await buildCenterApi('/api/center/projects/release', { projectId, projectIds }, config)
  resetSupplierLicenseCache()
  return true
}

async function buildCenterBinary(pathname, body = {}, config = null) {
  const resolved = config || await getBuildCenterConfig()
  if (!resolved.enabled) throw new Error('官方构建中心未配置')
  const serviceToken = authorizationClient ? await authorizationClient.serviceToken('official-resources') : resolved.token
  const response = await fetch(`${resolved.url}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceToken}`,
    },
    body: JSON.stringify({ ...body, supplierId: body.supplierId || resolved.supplierId }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || data.message || `HTTP ${response.status}`)
  }
  const encodedManifest = response.headers.get('x-agent-skill-manifest') || ''
  if (!encodedManifest) throw new Error('官方中心技能包缺少签名清单')
  return {
    packageBuffer: Buffer.from(await response.arrayBuffer()),
    manifest: JSON.parse(Buffer.from(encodedManifest, 'base64').toString('utf8')),
  }
}

const authorizationClient = deploymentRuntime()
const authorizeOfficialService = officialAuthorization()
const legacySupplierLicense = createSupplierLicenseService({
  officialCenterEnabled: CENTER_SUPPLIER_MANAGEMENT_ENABLED,
  defaults: defaultSupplierLicense,
  getConfig: getBuildCenterConfig,
  configCacheKey: buildCenterConfigCacheKey,
  listProjectIds: listLocalSupplierProjectIds,
  centerApi: buildCenterApi,
  organizationRepository,
})

async function getSupplierLicense(options = {}) {
  if (!authorizationClient) return legacySupplierLicense.getSupplierLicense(options)
  if (options.force) await authorizationClient.refresh(true).catch(() => {})
  const license = await authorizationClient.license()
  if (license.verified) await organizationRepository.syncLocalRootAuthorization({
    organizationId: license.id, externalId: license.id, name: license.name, status: 'enabled', preserveBusinessStatus: true, expiresAt: license.expiresAt,
    authorizationVersion: license.version, capabilities: license.capabilities,
  }, { userId: 'license-center-sync' })
  return license
}
function resetSupplierLicenseCache() {
  legacySupplierLicense.resetSupplierLicenseCache()
  if (authorizationClient) void authorizationClient.refresh(true).catch(() => {})
}
getSupplierLicense.forOrganization = authorizationClient ? id => authorizationClient.license(id) : null

async function getAdminVersion() {
  try {
    const raw = await fsp.readFile(path.join(repoRoot, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw)
    return String(pkg.version || '')
  } catch {
    return ''
  }
}

function normalizeReleaseNotes(notes) {
  if (!notes) return ''
  if (Array.isArray(notes)) {
    return notes.map((item) => {
      if (typeof item === 'string') return item
      return item?.note || item?.notes || item?.releaseNotes || ''
    }).filter(Boolean).join('\n')
  }
  return String(notes)
}

function normalizeSourceVersionManifest(raw) {
  const manifest = raw && typeof raw === 'object' ? raw : {}
  const current = {
    version: String(manifest.version || '').trim(),
    publishedAt: String(manifest.publishedAt || manifest.releaseDate || '').trim(),
    releaseNotes: normalizeReleaseNotes(manifest.releaseNotes),
    commit: String(manifest.commit || '').trim(),
    sourceOnly: manifest.sourceOnly === true,
  }
  const history = Array.isArray(manifest.history)
    ? manifest.history.map((item) => ({
      version: String(item?.version || '').trim(),
      publishedAt: String(item?.publishedAt || item?.releaseDate || '').trim(),
      releaseNotes: normalizeReleaseNotes(item?.releaseNotes),
    })).filter((item) => {
      const comparison = compareSemanticVersions(item.version, '3.0.0-beta.1')
      return comparison !== null && comparison >= 0
    })
    : []
  if (current.version && !history.some((item) => item.version === current.version)) {
    history.unshift({ version: current.version, publishedAt: current.publishedAt, releaseNotes: current.releaseNotes })
  }
  return { ...current, history: mergeReleaseHistory(current, history, readReleaseHistory(path.join(repoRoot, 'docs', 'AGENT_UPDATE_HISTORY.json')), Infinity) }
}

function validateDesktopSourceInfo(info) {
  if (!info.version) throw new Error('missing version')
  const supported = compareSemanticVersions(info.version, DESKTOP_NEXT_MIN_VERSION)
  if (supported === null) throw new Error(`invalid Desktop SemVer: ${info.version}`)
  if (supported < 0) {
    throw new Error(`legacy Desktop source ${info.version} is not supported; expected Desktop Next ${DESKTOP_NEXT_MIN_VERSION} or newer`)
  }
  return info
}

async function getSourceVersionInfo() {
  const url = String(SOURCE_VERSION_URL || '').trim()
  if (!url) return { version: '', configured: false, releaseNotes: '', publishedAt: '', commit: '', sourceOnly: false, history: [] }
  const now = Date.now()
  if (sourceVersionCache.info && now - sourceVersionCache.checkedAt < 60000) return sourceVersionCache.info
  try {
    const info = validateDesktopSourceInfo(normalizeSourceVersionManifest(await fetchJson(url)))
    if (!info.sourceOnly || !/^[a-f0-9]{40}$/.test(info.commit)) throw new Error('invalid canonical Desktop source manifest')
    const historyFile = path.join(repoRoot, 'data', 'agent-release-history.json')
    const completeHistory = mergeReleaseHistory(info, info.history, [...readReleaseHistory(historyFile), ...readReleaseHistory(path.join(repoRoot, 'docs', 'AGENT_UPDATE_HISTORY.json'))], Infinity)
    info.history = completeHistory.slice(0, 50)
    try {
      await fsp.mkdir(path.dirname(historyFile), { recursive: true })
      await fsp.writeFile(`${historyFile}.tmp`, `${JSON.stringify(completeHistory, null, 2)}\n`, 'utf8')
      await fsp.rename(`${historyFile}.tmp`, historyFile)
    } catch (error) {
      console.warn(`[ai-admin] could not persist Agent release history: ${error.message}`)
    }
    sourceVersionCache = { info: { ...info, configured: true, source: url }, checkedAt: now }
    return sourceVersionCache.info
  } catch (err) {
    console.warn('[ai-admin] Failed to fetch Agent source version:', err instanceof Error ? err.message : err)
    if (sourceVersionCache.info?.version) {
      sourceVersionCache = {
        info: {
          ...sourceVersionCache.info,
          stale: true,
          error: err instanceof Error ? err.message : String(err),
        },
        checkedAt: now,
      }
      return sourceVersionCache.info
    }
    sourceVersionCache = { info: { version: '', configured: false, releaseNotes: '', publishedAt: '', commit: '', sourceOnly: false, history: [], error: err instanceof Error ? err.message : String(err) }, checkedAt: now }
    return sourceVersionCache.info
  }
}

async function getVisibleSourceVersionInfo({ fullHistory = false } = {}) {
  const now = Date.now()
  if (!fullHistory && visibleSourceVersionCache.info && now - visibleSourceVersionCache.checkedAt < 60000) return visibleSourceVersionCache.info
  if (!CENTER_SUPPLIER_MANAGEMENT_ENABLED) {
    const config = await getBuildCenterConfig().catch(() => null)
    if (config?.enabled) {
      try {
        const info = await buildCenterApi('/api/center/source-version', fullHistory ? { history: 'all' } : {}, config)
        if (info?.version) {
          const result = { ...info, configured: true, source: 'build-center' }
          visibleSourceVersionCache = { info: { ...result, history: Array.isArray(info.history) ? info.history.slice(0, 50) : [] }, checkedAt: now }
          return fullHistory ? result : visibleSourceVersionCache.info
        }
      } catch (err) {
        console.warn('[ai-admin] Failed to fetch Agent source version from build center:', err instanceof Error ? err.message : err)
      }
    }
  }
  const info = await getSourceVersionInfo()
  visibleSourceVersionCache = { info, checkedAt: now }
  return info
}

async function getSourceVersion() {
  return (await getSourceVersionInfo()).version || ''
}

function compareVersions(a, b) {
  const semanticResult = compareSemanticVersions(a, b)
  if (semanticResult !== null) return semanticResult
  const left = String(a || '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const right = String(b || '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    if ((left[i] || 0) > (right[i] || 0)) return 1
    if ((left[i] || 0) < (right[i] || 0)) return -1
  }
  return 0
}

function validateManifest(manifest, fallbackHistory = []) {
  const version = String(manifest?.version || '').trim()
  const zipUrl = String(manifest?.zipUrl || manifest?.url || '').trim()
  const sha256 = String(manifest?.sha256 || '').trim().toLowerCase()
  if (!version) throw new Error('更新清单缺少 version')
  if (!/^https?:\/\//i.test(zipUrl)) throw new Error('更新清单缺少有效 zipUrl')
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('更新清单缺少有效 sha256')
  const currentEntry = {
    version,
    publishedAt: String(manifest?.publishedAt || ''),
    releaseNotes: String(manifest?.releaseNotes || ''),
  }
  const history = Array.isArray(manifest?.history)
    ? manifest.history.map((item) => ({
      version: String(item?.version || '').trim(),
      publishedAt: String(item?.publishedAt || ''),
      releaseNotes: String(item?.releaseNotes || ''),
    })).filter((item) => item.version)
    : []
  if (!history.some((item) => item.version === version)) history.unshift(currentEntry)
  return {
    version,
    zipUrl,
    sha256,
    releaseNotes: String(manifest?.releaseNotes || ''),
    publishedAt: String(manifest?.publishedAt || ''),
    history: mergeReleaseHistory(currentEntry, history, fallbackHistory),
  }
}

async function getSelfUpdateStatus({ fullHistory = false } = {}) {
  const runningVersion = PACKAGE_VERSION
  const diskVersion = await getAdminVersion()
  const manifestUrl = await getConfiguredSelfUpdateManifestUrl()
  const restartStatus = await readSelfUpdateRestartStatus(SELF_UPDATE_WORK_DIR)
  const status = {
    enabled: Boolean(manifestUrl),
    configured: Boolean(manifestUrl),
    currentVersion: runningVersion,
    runningVersion,
    diskVersion,
    versionMismatch: Boolean(diskVersion && runningVersion && diskVersion !== runningVersion),
    restartStatus,
    latestVersion: '',
    updateAvailable: false,
    manifestUrl,
    envManifestUrl: SELF_UPDATE_MANIFEST_URL,
    releaseNotes: '',
    publishedAt: '',
    history: [],
    lastLog: await readSelfUpdateLog(),
  }
  if (!manifestUrl) return status
  const officialHistory = /^https?:\/\/(?:updates\.okpa\.cn|8\.147\.134\.68)\/agent\/ai-admin\/latest\.json$/.test(manifestUrl)
    ? readReleaseHistory(path.join(repoRoot, 'docs', 'UPDATE_HISTORY.json')) : []
  const rawManifest = await fetchJson(manifestUrl)
  const manifest = validateManifest(rawManifest, officialHistory)
  status.latestVersion = manifest.version
  status.updateAvailable = compareVersions(manifest.version, runningVersion) > 0
  status.releaseNotes = manifest.releaseNotes
  status.publishedAt = manifest.publishedAt
  status.history = fullHistory ? readAdminReleaseHistory({ ...manifest, history: rawManifest.history, manifestUrl }, repoRoot) : manifest.history
  return status
}

let selfUpdateInProgress = false
async function applySelfUpdate() {
  if (selfUpdateInProgress) throw new Error('管理端升级正在进行，请等待重启验证完成')
  selfUpdateInProgress = true
  try {
    return await performSelfUpdate()
  } catch (error) {
    selfUpdateInProgress = false
    throw error
  }
}

async function performSelfUpdate() {
  const manifestUrl = await getConfiguredSelfUpdateManifestUrl()
  if (!manifestUrl) throw new Error('未配置 AI_ADMIN_UPDATE_MANIFEST_URL')
  await fsp.mkdir(SELF_UPDATE_WORK_DIR, { recursive: true })
  await appendSelfUpdateLog('Checking update manifest...')
  const manifest = validateManifest(await fetchJson(manifestUrl))
  const currentVersion = PACKAGE_VERSION
  const diskVersion = await getAdminVersion()
  if (compareVersions(manifest.version, currentVersion) <= 0) {
    throw new Error(`当前已是最新版本：${currentVersion}`)
  }

  const pm2Target = await resolveCurrentPm2Process({
    runCommand,
    pm2Bin: SELF_UPDATE_PM2_BIN,
    configuredName: SELF_UPDATE_PM2_NAME,
    repoRoot,
  })
  await appendSelfUpdateLog(`PM2 instance verified: ${pm2Target.name} pid=${pm2Target.pid} cwd=${pm2Target.cwd}`)

  if (diskVersion === manifest.version) {
    await appendSelfUpdateLog(`Files already contain ${manifest.version}; retrying the verified process restart`)
    const restartStatus = await scheduleVerifiedSelfRestart({
      repoRoot,
      workDir: SELF_UPDATE_WORK_DIR,
      pm2Bin: SELF_UPDATE_PM2_BIN,
      pm2Name: pm2Target.name,
      previousPid: pm2Target.pid,
      port: PORT,
      expectedVersion: manifest.version,
      delayMs: SELF_UPDATE_RESTART_DELAY_MS,
      publicUrl: PUBLIC_ADMIN_BASE_URL,
    })
    return {
      currentVersion,
      runningVersion: currentVersion,
      diskVersion,
      latestVersion: manifest.version,
      updateAvailable: true,
      restartStatus,
      message: 'Application files are current; a verified PM2 restart has been scheduled.',
    }
  }

  const runId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const runDir = path.join(SELF_UPDATE_WORK_DIR, runId)
  const zipPath = path.join(runDir, 'update.zip')
  const extractDir = path.join(runDir, 'extract')
  const backupDir = path.join(SELF_UPDATE_WORK_DIR, 'backups', `backup-${currentVersion || 'unknown'}-${runId}`)
  await fsp.mkdir(runDir, { recursive: true })
  try {
  await appendSelfUpdateLog(`Downloading ${manifest.zipUrl}`)
  const bytes = await downloadFile(manifest.zipUrl, zipPath)
  await appendSelfUpdateLog(`Downloaded ${bytes} bytes`)
  const actualSha256 = await sha256File(zipPath)
  if (actualSha256 !== manifest.sha256) {
    throw new Error(`sha256 校验失败：expected ${manifest.sha256}, got ${actualSha256}`)
  }
  await appendSelfUpdateLog('sha256 verified')

  await fsp.mkdir(extractDir, { recursive: true })
  await runCommand('unzip', ['-q', zipPath, '-d', extractDir])
  const extractedPackage = JSON.parse(await fsp.readFile(path.join(extractDir, 'package.json'), 'utf-8'))
  if (extractedPackage.name !== 'agent-ai-admin') {
    throw new Error('更新包 package.json 不属于 agent-ai-admin')
  }
  if (String(extractedPackage.version || '') !== manifest.version) {
    throw new Error(`更新包版本 ${extractedPackage.version || '-'} 与清单版本 ${manifest.version} 不一致`)
  }

  await appendSelfUpdateLog(`Backing up current app to ${backupDir}`)
  await fsp.mkdir(backupDir, { recursive: true })
  // Back up application code only; custom work directories must never copy into themselves.
  for (const name of ['cloud', 'src', 'web', 'docs', 'scripts', 'package.json', 'package-lock.json', '.env.example', '.gitignore', 'install.php']) {
    const source = path.join(repoRoot, name)
    const info = await fsp.lstat(source).catch(() => null)
    if (!info || info.isSymbolicLink()) continue
    if (info.isDirectory()) await copyDir(source, path.join(backupDir, name), { skipNames: new Set(['node_modules', 'uploads', 'data', '.git', 'logs']) })
    else if (info.isFile()) await fsp.copyFile(source, path.join(backupDir, name))
  }

  await appendSelfUpdateLog('Replacing application files...')
  for (const name of ['cloud', 'src', 'web', 'docs', 'scripts', 'package.json', 'package-lock.json', '.env.example', '.gitignore', 'install.php']) {
    await removeIfExists(path.join(repoRoot, name))
  }
  await copyDir(extractDir, repoRoot)

  await appendSelfUpdateLog('Installing production dependencies...')
  const npmEnv = path.isAbsolute(SELF_UPDATE_NPM_BIN)
    ? { PATH: `${path.dirname(SELF_UPDATE_NPM_BIN)}${path.delimiter}${process.env.PATH || ''}` }
    : {}
  await runCommand(SELF_UPDATE_NPM_BIN, ['install', '--omit=dev'], { env: npmEnv })

  await appendSelfUpdateLog(`Update applied: ${currentVersion} -> ${manifest.version}`)
  await appendSelfUpdateLog(`Scheduling verified PM2 restart: ${pm2Target.name}`)
  const restartStatus = await scheduleVerifiedSelfRestart({
    repoRoot,
    workDir: SELF_UPDATE_WORK_DIR,
    pm2Bin: SELF_UPDATE_PM2_BIN,
    pm2Name: pm2Target.name,
    previousPid: pm2Target.pid,
    port: PORT,
    expectedVersion: manifest.version,
    delayMs: SELF_UPDATE_RESTART_DELAY_MS,
    publicUrl: PUBLIC_ADMIN_BASE_URL,
  })

  return {
    currentVersion,
    runningVersion: currentVersion,
    diskVersion: manifest.version,
    latestVersion: manifest.version,
    updateAvailable: true,
    fromVersion: currentVersion,
    toVersion: manifest.version,
    backupDir,
    restartApp: pm2Target.name,
    restartStatus,
    message: 'Files installed; PM2 restart and frontend verification are in progress.',
  }
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true }).catch((error) => appendSelfUpdateLog(`Temporary update cleanup failed: ${error.message}`))
  }
}

async function saveUploadFile(input, user, publicAdminBaseUrl = PUBLIC_ADMIN_BASE_URL) {
  const dataUrl = String(input?.dataUrl || '')
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|gif|x-icon|vnd\.microsoft\.icon));base64,([a-zA-Z0-9+/=]+)$/)
  if (!match) throw new Error('只支持 png、jpg、webp、gif、ico 图片')
  const mime = match[1]
  const extMap = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico',
  }
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length > 3 * 1024 * 1024) throw new Error('图片不能超过 3MB')
  if ((extMap[mime] || '').toLowerCase() === '.ico' && !icoContainsSize(buffer, WINDOWS_ICON_MIN_SIZE)) {
    throw new Error(`安装包图标必须包含至少 ${WINDOWS_ICON_MIN_SIZE}x${WINDOWS_ICON_MIN_SIZE} 尺寸，请重新上传符合 Windows 安装包要求的 .ico 文件`)
  }
  const scope = slugify(user?.id || user?.username || 'user')
  const dir = path.join(UPLOAD_DIR, scope)
  await fsp.mkdir(dir, { recursive: true })
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extMap[mime] || '.png'}`
  await fsp.writeFile(path.join(dir, filename), buffer)
  return canonicalizePublicUploadUrl(`/uploads/${scope}/${filename}`, publicAdminBaseUrl || PUBLIC_ADMIN_BASE_URL)
}

function resolveLocalUploadAsset(value) {
  const raw = String(value || '').trim()
  if (!raw || /^data:/i.test(raw)) return { raw, isLocalUpload: false }
  let pathname = ''
  try {
    if (raw.startsWith('/uploads/')) {
      pathname = raw
    } else {
      const url = new URL(raw)
      const base = new URL(PUBLIC_ADMIN_BASE_URL)
      pathname = url.pathname
      const basePath = base.pathname.replace(/\/$/, '')
      if (basePath && pathname.startsWith(`${basePath}/uploads/`)) {
        pathname = pathname.slice(basePath.length)
      } else if (url.hostname.toLowerCase() !== base.hostname.toLowerCase()) {
        return { raw, isLocalUpload: false }
      }
    }
  } catch {
    return { raw, isLocalUpload: false }
  }
  if (!pathname.startsWith('/uploads/')) return { raw, isLocalUpload: false }
  const relativePath = decodeURIComponent(pathname.replace(/^\/uploads\/+/, ''))
  if (!relativePath || relativePath.includes('\0')) return { raw, isLocalUpload: false }
  const filePath = path.resolve(UPLOAD_DIR, relativePath)
  const uploadRoot = path.resolve(UPLOAD_DIR)
  if (!(filePath === uploadRoot || filePath.startsWith(`${uploadRoot}${path.sep}`))) return { raw, isLocalUpload: false }
  return { raw, isLocalUpload: true, filePath }
}

async function localUploadUrlToDataUrl(value) {
  const asset = resolveLocalUploadAsset(value)
  if (!asset.isLocalUpload) return asset.raw
  const { raw, filePath } = asset
  const mime = mimeFromAssetPath(filePath)
  if (!mime) return raw
  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size > 5 * 1024 * 1024) return raw
  const buffer = await fsp.readFile(filePath)
  return `data:${mime};base64,${buffer.toString('base64')}`
}

async function uploadBrandAssetBufferToImageBed(buffer, fileName, mime) {
  if (!BRAND_ASSET_IMAGE_BED_UPLOAD_URL) return ''
  const ext = path.extname(fileName).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return ''
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > 10 * 1024 * 1024) return ''
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mime || mimeFromAssetPath(fileName) || 'application/octet-stream' }), path.basename(fileName))
  const response = await fetch(BRAND_ASSET_IMAGE_BED_UPLOAD_URL, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15_000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.success === false || !data.url) {
    throw new Error(data.error || data.message || `HTTP ${response.status}`)
  }
  return String(data.url || '').trim()
}

async function uploadBrandAssetToImageBed(filePath) {
  if (!BRAND_ASSET_IMAGE_BED_UPLOAD_URL) return ''
  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size > 10 * 1024 * 1024) return ''
  return uploadBrandAssetBufferToImageBed(await fsp.readFile(filePath), filePath, mimeFromAssetPath(filePath))
}

async function fetchBrandAssetBuffer(raw) {
  const value = String(raw || '').trim()
  if (!/^https?:\/\//i.test(value)) return null
  try {
    const response = await fetch(value, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (!response.ok) return null
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (contentType && !contentType.startsWith('image/')) return null
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > 5 * 1024 * 1024) return null
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    if (buffer.length > 5 * 1024 * 1024) return null
    return {
      buffer,
      mime: contentType || mimeFromAssetPath(new URL(value).pathname),
    }
  } catch {
    return null
  }
}

async function localUploadUrlToBuildAssetUrl(value, label = '品牌图片') {
  const asset = resolveLocalUploadAsset(value)
  if (!asset.isLocalUpload) return asset.raw
  const { raw, filePath } = asset
  const mime = mimeFromAssetPath(filePath)
  if (!mime) throw new Error(`${label}文件类型不支持，请重新上传 png、jpg、webp、gif 或 ico 图片`)
  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat?.isFile()) {
    const fetched = await fetchBrandAssetBuffer(raw)
    if (!fetched?.buffer || !fetched.mime?.startsWith('image/')) {
      throw new Error(`${label}文件不存在或无法安全访问，请在 AI 项目编辑页重新上传后再提交构建`)
    }
    const remotePath = new URL(raw).pathname
    const fallbackExtension = fetched.mime.includes('icon') ? '.ico' : fetched.mime.includes('jpeg') ? '.jpg' : fetched.mime.includes('gif') ? '.gif' : fetched.mime.includes('webp') ? '.webp' : '.png'
    const remoteName = path.extname(remotePath) ? path.basename(remotePath) : `brand${fallbackExtension}`
    try {
      return await uploadBrandAssetBufferToImageBed(fetched.buffer, remoteName, fetched.mime)
        || `data:${fetched.mime};base64,${fetched.buffer.toString('base64')}`
    } catch {
      return `data:${fetched.mime};base64,${fetched.buffer.toString('base64')}`
    }
  }
  if (stat.size > 5 * 1024 * 1024) {
    throw new Error(`${label}文件超过 5MB，请压缩或重新上传后再提交构建`)
  }
  try {
    return await uploadBrandAssetToImageBed(filePath) || await localUploadUrlToDataUrl(raw)
  } catch {
    return localUploadUrlToDataUrl(raw)
  }
}

function sanitizeUser(user) {
  if (!user) return null
  const { passwordHash, password_hash, ...safe } = user
  return safe
}

function normalizeUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    email: row.email || '',
    displayName: row.display_name,
    role: row.role,
    roleTemplateId: row.role_template_id || '',
    primaryOrganizationId: row.primary_organization_id || '',
    dataScope: row.data_scope || '',
    status: row.status,
    maxProjects: Number(row.max_projects || 0),
    maxBuilds: Number(row.max_builds || 0),
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeUserGroup(row) {
  if (!row) return null
  return {
    id: row.id,
    organizationId: row.organization_id || '',
    name: row.name,
    description: row.description || '',
    status: row.status || 'enabled',
    sortOrder: Number(row.sort_order || 0),
    memberCount: Number(row.member_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeRoleTemplate(row, permissionKeys = []) {
  if (!row) return null
  return {
    id: row.id,
    organizationId: row.organization_id || '',
    name: row.name,
    description: row.description || '',
    baseRole: row.base_role || 'agent',
    status: row.status || 'enabled',
    sortOrder: Number(row.sort_order || 0),
    systemBuiltin: Boolean(row.system_builtin),
    permissionKeys,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeProject(row, publicAdminBaseUrl = PUBLIC_ADMIN_BASE_URL) {
  if (!row) return null
  const project = {
    id: row.id,
    organizationId: row.organization_id || '',
    organizationId: row.organization_id || '',
    ownerUserId: row.owner_user_id,
    organizationId: row.organization_id || '',
    ownerUsername: row.owner_username || '',
    ownerDisplayName: row.owner_display_name || '',
    ownerRole: row.owner_role || '',
    clientMode: 'personal',
    clientPolicy: normalizeClientPolicy(row.client_policy_json),
    appName: row.app_name,
    brandName: row.brand_name,
    shortName: row.short_name,
    description: row.description,
    appId: row.app_id,
    configDirName: row.config_dir_name,
    logoUrl: canonicalizePublicUploadUrl(row.logo_url, publicAdminBaseUrl),
    iconUrl: canonicalizePublicUploadUrl(row.icon_url, publicAdminBaseUrl),
    contactQrUrl: canonicalizePublicUploadUrl(row.contact_qr_url, publicAdminBaseUrl),
    loginLogoUrl: canonicalizePublicUploadUrl(row.login_logo_url, publicAdminBaseUrl),
    loginDesign: normalizeLoginDesign(row.login_design || undefined),
    loginTitle: row.login_title,
    loginSubtitle: row.login_subtitle,
    loginHeroTitle: row.login_hero_title,
    loginHeroSubtitle: row.login_hero_subtitle,
    aboutText: row.about_text,
    officialSiteUrl: row.official_site_url,
    docsUrl: row.docs_url,
    modelTutorialUrl: row.model_tutorial_url,
    menus: parseJson(row.client_menus, []),
    themeColor: row.theme_color,
    showGithubLink: Boolean(row.show_github_link),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (Object.prototype.hasOwnProperty.call(row, 'can_operate')) project.canOperate = Boolean(row.can_operate)
  return project
}

function normalizeBuild(row) {
  if (!row) return null
  const storedBrand = parseJson(row.brand_json, null)
  const build = {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name || row.app_name || '',
    projectClientMode: row.project_client_mode ? 'personal' : '',
    ownerUserId: row.owner_user_id,
    organizationId: row.organization_id || '',
    ownerUsername: row.owner_username || '',
    ownerDisplayName: row.owner_display_name || '',
    ownerRole: row.owner_role || '',
    requestedBy: row.requested_by,
    version: row.version,
    status: row.status,
    log: redactPublicBuildLog(row.log),
    error: redactPublicBuildLog(row.error),
    artifactDir: row.artifact_dir || '',
    publicUrl: row.public_url || '',
    releaseUrl: row.release_url || '',
    releaseStatus: row.release_status || '',
    releaseError: redactPublicBuildLog(row.release_error),
    files: parseJson(row.files, []),
    transferProgress: parseJson(row.transfer_progress, null),
    brand: storedBrand && typeof storedBrand === 'object' ? { ...storedBrand, clientMode: 'personal' } : storedBrand,
    remoteBuildId: row.remote_build_id || '',
    centerSupplierId: row.center_supplier_id || '',
    centerLocalBuildId: row.center_local_build_id || '',
    delegatedToCenter: isDelegatedBuildRecord(row),
    claimedBy: row.claimed_by || '',
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    releasedAt: row.released_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (Object.prototype.hasOwnProperty.call(row, 'can_operate')) build.canOperate = Boolean(row.can_operate)
  return build
}

function normalizeEndUser(row) {
  if (!row) return null
  const modelGatewayKey = String(row.model_gateway_key || '')
  return {
    id: row.id,
    username: row.username,
    email: row.email || '',
    displayName: row.display_name,
    status: row.status,
    organizationId: row.organization_id || '',
    sourceSupplierId: row.source_supplier_id || '',
    sourceAgentId: row.source_agent_id || '',
    sourceProjectId: row.source_project_id || '',
    sourceBuildId: row.source_build_id || '',
    centerProjectId: row.center_project_id || '',
    channelCode: row.channel_code || '',
    appVersion: row.app_version || '',
    deviceId: row.device_id || '',
    sessionDeviceId: row.session_device_id || '',
    deviceName: row.device_name || '',
    creditBalance: Number(row.credit_balance || 0),
    modelGatewayKey,
    modelGatewayKeyPreview: previewSecret(modelGatewayKey),
    modelGatewayKeyConfigured: Boolean(modelGatewayKey),
    modelPointsPerUsd: Number(row.model_points_per_usd || 0),
    modelPointsPerUsdConfigured: Number(row.model_points_per_usd || 0) > 0,
    allowedModelCount: Number(row.allowed_model_count || 0),
    operationOwnerUserId: row.operation_owner_user_id || '',
    canOperate: Boolean(row.can_operate),
    membership: row.membership_id ? {
      id: row.membership_id,
      cardId: row.membership_card_id || '',
      cardName: row.membership_card_name || '',
      cardLevel: Number(row.membership_card_level || 0),
      packageName: row.membership_package_name || '',
      startedAt: row.membership_started_at,
      expiresAt: row.membership_expires_at,
      pointsExpiresAt: row.membership_points_expires_at,
      status: row.membership_status || 'active',
      allowedModelCount: Number(row.membership_allowed_model_count || 0),
    } : null,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function previewSecret(value, head = 8, tail = 6) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.length <= head + tail + 3) return text
  return `${text.slice(0, head)}...${text.slice(-tail)}`
}

function sanitizeEndUser(user) {
  if (!user) return null
  const { passwordHash, password_hash, modelGatewayKey, ...safe } = user
  return safe
}

function normalizeWorker(row) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status || 'offline',
    currentBuildId: row.current_build_id || '',
    lastSeenAt: row.last_seen_at,
    lastClaimedAt: row.last_claimed_at,
    lastCompletedAt: row.last_completed_at,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}


function normalizeModelProvider(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name || '',
    protocol: row.protocol || 'openai-compatible',
    baseUrl: row.base_url || '',
    status: row.status || 'enabled',
    isDefault: Boolean(row.is_default),
    timeoutMs: Number(row.timeout_ms || 120000),
    sortOrder: Number(row.sort_order || 0),
    notes: row.notes || '',
    keyMode: Boolean(row.has_managed_voice) || row.id === SYSTEM_AUDIO_PROVIDER_ID ? 'single_voice' : 'pool',
    isSystem: isSystemImageRecordId(row.id),
    organizationId: row.organization_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}


async function listModelProviderKeyUsage(keyId = '', ownerUserId = 'admin', page = 1, pageSize = 20) {
  const id = String(keyId || '').trim()
  if (!id) throw new Error('Key ID 不能为空')
  const current = Math.max(1, Number(page || 1))
  const size = Math.max(1, Math.min(100, Number(pageSize || 20)))
  const offset = (current - 1) * size
  const owner = String(ownerUserId || 'admin')
  const [[keyRow]] = await db().query(
    'SELECT id FROM ai_model_provider_keys WHERE id = ? AND owner_user_id = ? LIMIT 1',
    [id, owner],
  )
  if (!keyRow) {
    const err = new Error('Key 不存在或无权查看其调用明细')
    err.statusCode = 403
    throw err
  }
  const [[countRow]] = await db().query(
    `SELECT COUNT(*) AS total FROM ai_credit_ledger WHERE provider_key_id = ? AND change_type = 'consume'`,
    [id],
  )
  const [rows] = await db().query(
    `SELECT l.*, u.username AS username, u.display_name AS display_name
     FROM ai_credit_ledger l
     LEFT JOIN ai_end_users u ON u.id = l.user_id
     WHERE l.provider_key_id = ? AND l.change_type = 'consume'
     ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`,
    [id, size, offset],
  )
  const total = Number(countRow?.total || 0)
  return {
    items: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username || '',
      displayName: r.display_name || '',
      requestId: r.request_id || '',
      modelName: r.model_name || '',
      providerName: r.provider_name || '',
      providerKeyPreview: r.provider_key_preview || '',
      promptTokens: Number(r.prompt_tokens || 0),
      completionTokens: Number(r.completion_tokens || 0),
      totalTokens: Number(r.total_tokens || 0),
      costUsd: Number(r.cost_usd || 0),
      pointsDelta: Number(r.points_delta || 0),
      deductStatus: r.deduct_status || '',
      note: r.note || '',
      createdAt: r.created_at,
    })),
    total,
    page: current,
    pageSize: size,
    totalPages: Math.max(1, Math.ceil(total / size)),
  }
}

function normalizeProviderModel(row) {
  if (!row) return null
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name || '',
    modelId: row.model_id || '',
    displayName: row.display_name || row.model_id || '',
    description: row.description || '',
    modelType: row.model_type || 'text',
    endpointPath: row.endpoint_path || '',
    status: row.status || 'enabled',
    isDefault: Boolean(row.is_default),
    capabilities: parseJson(row.capabilities, []),
    reasoning: normalizeModelReasoning(parseJson(row.reasoning_config, {})),
    contextWindow: Number(row.context_window || 0),
    sortOrder: Number(row.sort_order || 0),
    isSystem: isSystemImageRecordId(row.id),
    organizationId: row.organization_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeModelPricingRule(row) {
  if (!row) return null
  const rule = {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name || '',
    providerModelId: row.provider_model_id,
    modelId: row.model_id || '',
    displayName: row.display_name || row.model_id || '',
    billingType: row.billing_type || 'per_token',
    inputPointsPerMTokens: Number(row.input_points_per_m_tokens || 0),
    outputPointsPerMTokens: Number(row.output_points_per_m_tokens || 0),
    pointsPerRequest: Number(row.points_per_request || 0),
    inputCostPointsPerMTokens: Number(row.input_cost_points_per_m_tokens ?? row.input_points_per_m_tokens ?? 0),
    outputCostPointsPerMTokens: Number(row.output_cost_points_per_m_tokens ?? row.output_points_per_m_tokens ?? 0),
    costPointsPerRequest: Number(row.cost_points_per_request ?? row.points_per_request ?? 0),
    consumptionMultiplier: normalizeConsumptionMultiplier(row.consumption_multiplier ?? row.consumptionMultiplier, 1),
    resolutionPoints: row.billing_type === IMAGE_BILLING_TYPE
      ? normalizeImageResolutionPoints(parseJson(row.resolution_points, {}))
      : {},
    resolutionCostPoints: row.billing_type === IMAGE_BILLING_TYPE
      ? normalizeImageResolutionPoints(parseJson(row.resolution_cost_points ?? row.resolution_points, {}))
      : {},
    isSystem: isSystemImageRecordId(row.id),
    status: row.status || 'enabled',
    organizationId: row.organization_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  rule.multipliers = pricingRuleMultipliers(rule)
  return rule
}

function normalizeLoginContent(value) {
  const defaults = defaultPlatformSettings.loginContent
  const raw = typeof value === 'string' ? parseJson(value, {}) : (value && typeof value === 'object' ? value : {})
  const text = (key, maxLength = 160) => String(raw[key] || defaults[key]).trim().slice(0, maxLength) || defaults[key]
  const pairs = (key) => defaults[key].map((fallback, index) => {
    const item = Array.isArray(raw[key]) && raw[key][index] && typeof raw[key][index] === 'object' ? raw[key][index] : {}
    return {
      title: String(item.title || fallback.title).trim().slice(0, 80) || fallback.title,
      subtitle: String(item.subtitle || fallback.subtitle).trim().slice(0, 120) || fallback.subtitle,
    }
  })
  return {
    kicker: text('kicker', 80),
    panelEyebrow: text('panelEyebrow', 80),
    panelTitle: text('panelTitle', 80),
    panelSubtitle: text('panelSubtitle', 160),
    accountLabel: text('accountLabel', 40),
    accountPlaceholder: text('accountPlaceholder', 160),
    passwordLabel: text('passwordLabel', 40),
    passwordPlaceholder: text('passwordPlaceholder', 160),
    submitText: text('submitText', 40),
    securityText: text('securityText', 200),
    interactionHint: text('interactionHint', 80),
    signals: pairs('signals'),
    capabilities: pairs('capabilities'),
  }
}

function normalizeCrystalFaceTexts(value) {
  const raw = typeof value === 'string' ? parseJson(value, {}) : (value && typeof value === 'object' ? value : {})
  return Object.fromEntries(Object.keys(defaultPlatformSettings.crystalFaceTexts).map((key) => [
    key,
    Object.prototype.hasOwnProperty.call(raw, key) ? String(raw[key] ?? '').trim().slice(0, 12) : '',
  ]))
}

function normalizePlatformSettings(row = {}) {
  return {
    ...defaultPlatformSettings,
    systemName: String(row.system_name || defaultPlatformSettings.systemName),
    systemSubtitle: String(row.system_subtitle || defaultPlatformSettings.systemSubtitle),
    loginTitle: String(row.login_title || defaultPlatformSettings.loginTitle),
    loginSubtitle: String(row.login_subtitle || defaultPlatformSettings.loginSubtitle),
    loginBackgroundUrl: String(row.login_background_url || ''),
    loginPanelColor: String(row.login_panel_color || defaultPlatformSettings.loginPanelColor),
    loginContent: normalizeLoginContent(row.login_content_json),
    primaryColor: String(row.primary_color || defaultPlatformSettings.primaryColor),
    logoText: row.logo_text == null ? defaultPlatformSettings.logoText : String(row.logo_text).slice(0, 4),
    crystalFaceTexts: normalizeCrystalFaceTexts(row.login_crystal_faces_json),
    selfUpdateManifestUrl: String(row.self_update_manifest_url || ''),
    buildCenterUrl: String(row.build_center_url || ''),
    buildCenterSupplierId: String(row.build_center_supplier_id || ''),
    buildCenterToken: String(row.build_center_token || ''),
    artifactStorageMode: normalizeArtifactStorageMode(row.artifact_storage_mode || defaultPlatformSettings.artifactStorageMode),
    ossAccessKeyId: String(row.oss_access_key_id || ''),
    ossAccessKeySecret: String(row.oss_access_key_secret || ''),
    ossBucket: String(row.oss_bucket || ''),
    ossEndpoint: normalizeOssEndpoint(row.oss_endpoint || ''),
    ossPublicBaseUrl: normalizeOssPublicBaseUrl({
      bucket: row.oss_bucket,
      endpoint: row.oss_endpoint,
      publicBaseUrl: row.oss_public_base_url,
    }),
    ossPrefix: trimSlashes(row.oss_prefix || defaultPlatformSettings.ossPrefix),
    modelGatewayBaseUrl: String(row.model_gateway_base_url || defaultPlatformSettings.modelGatewayBaseUrl),
    modelUsageBaseUrl: String(row.model_usage_base_url || defaultPlatformSettings.modelUsageBaseUrl),
    modelGatewayKey: String(row.model_gateway_key || ''),
    modelPointsPerUsd: Number(row.model_points_per_usd || defaultPlatformSettings.modelPointsPerUsd),
    smtpHost: String(row.smtp_host || ''),
    smtpPort: Number(row.smtp_port || defaultPlatformSettings.smtpPort),
    smtpSecure: row.smtp_secure == null ? defaultPlatformSettings.smtpSecure : Boolean(row.smtp_secure),
    smtpUser: String(row.smtp_user || ''),
    smtpPass: String(row.smtp_pass || ''),
    smtpFromName: String(row.smtp_from_name || defaultPlatformSettings.smtpFromName),
    smtpFromEmail: String(row.smtp_from_email || ''),
  }
}

function sanitizePlatformSettings(settings, options = {}) {
  const safe = { ...(settings || {}) }
  if (!options.includeBuildCenter) {
    delete safe.buildCenterUrl
    delete safe.buildCenterSupplierId
    delete safe.buildCenterToken
    delete safe.buildCenterConfigured
    delete safe.buildCenterConfigSource
    delete safe.effectiveBuildCenterUrl
    delete safe.effectiveBuildCenterSupplierId
    delete safe.artifactStorageMode
    delete safe.ossAccessKeyId
    delete safe.ossAccessKeySecret
    delete safe.ossBucket
    delete safe.ossEndpoint
    delete safe.ossPublicBaseUrl
    delete safe.ossPrefix
  }
  if (!options.includeSecrets) {
    safe.buildCenterTokenConfigured = Boolean(safe.buildCenterToken || safe.buildCenterTokenConfigured)
    safe.buildCenterTokenPreview = safe.buildCenterToken ? String(safe.buildCenterToken).slice(-8) : ''
    delete safe.buildCenterToken
    safe.ossAccessKeySecretConfigured = Boolean(safe.ossAccessKeySecret)
    safe.ossAccessKeySecretPreview = safe.ossAccessKeySecret ? String(safe.ossAccessKeySecret).slice(-8) : ''
    delete safe.ossAccessKeySecret
    safe.modelGatewayKeyConfigured = Boolean(safe.modelGatewayKey)
    delete safe.modelGatewayKey
    safe.smtpPassConfigured = Boolean(safe.smtpPass)
    safe.smtpPassPreview = safe.smtpPass ? String(safe.smtpPass).slice(-6) : ''
    delete safe.smtpPass
  }
  return safe
}

async function findUserById(id) {
  const [rows] = await db().query('SELECT u.*, m.data_scope FROM ai_users u LEFT JOIN ai_organization_members m ON m.user_id=u.id AND m.organization_id=u.primary_organization_id WHERE u.id = ? LIMIT 1', [id])
  return normalizeUser(rows[0])
}

async function findUserByUsername(username) {
  const [rows] = await db().query('SELECT u.*, m.data_scope FROM ai_users u LEFT JOIN ai_organization_members m ON m.user_id=u.id AND m.organization_id=u.primary_organization_id WHERE u.username = ? LIMIT 1', [safeUsername(username)])
  return normalizeUser(rows[0])
}

async function listUsers(context = null, query = {}) {
  const where = [], params = []
  if (context?.organizationId) { where.push('u.primary_organization_id=?'); params.push(context.organizationId) }
  const status = String(query.status || '').trim()
  const search = buildListSearch(query, {
    account: ['u.username', 'u.display_name'],
    accountId: ['u.id'],
    role: ['u.role_template_id', 'r.name'],
    organization: ['u.primary_organization_id'],
  })
  if (search.clause) { where.push(search.clause); params.push(...search.params) }
  if (status && status !== 'all') { where.push('u.status=?'); params.push(status) }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  const paged = isPaginationRequested(query), pagination = parsePagination(query)
  let total = 0
  if (paged) { const [[countRow]] = await db().query(`SELECT COUNT(*) AS total FROM ai_users u LEFT JOIN ai_role_templates r ON r.id=u.role_template_id${whereSql}`, params); total = Number(countRow?.total || 0) }
  const sql = `SELECT u.*, m.data_scope FROM ai_users u LEFT JOIN ai_organization_members m ON m.user_id=u.id AND m.organization_id=u.primary_organization_id LEFT JOIN ai_role_templates r ON r.id=u.role_template_id${whereSql} ORDER BY u.created_at DESC${paged ? ' LIMIT ? OFFSET ?' : ''}`
  const [rows] = await db().query(sql, paged ? [...params, pagination.pageSize, pagination.offset] : params)
  const items = rows.map(normalizeUser)
  return paged ? pageResult(items, total, pagination) : items
}

async function listUserGroups(context = null) {
  const [rows] = await db().query(`
    SELECT
      g.*,
      COUNT(m.user_id) AS member_count
    FROM ai_user_groups g
    LEFT JOIN ai_user_group_members m ON m.group_id = g.id
    ${context?.organizationId ? 'WHERE g.organization_id = ?' : ''}
    GROUP BY g.id
    ORDER BY g.sort_order ASC, g.created_at DESC
  `, context?.organizationId ? [context.organizationId] : [])
  return rows.map(normalizeUserGroup)
}

async function findUserGroupById(id, context = null) {
  const [rows] = await db().query(`
    SELECT
      g.*,
      COUNT(m.user_id) AS member_count
    FROM ai_user_groups g
    LEFT JOIN ai_user_group_members m ON m.group_id = g.id
    WHERE g.id = ? ${context?.organizationId ? 'AND g.organization_id = ?' : ''}
    GROUP BY g.id
    LIMIT 1
  `, context?.organizationId ? [String(id || '').trim(), context.organizationId] : [String(id || '').trim()])
  return normalizeUserGroup(rows[0])
}

function safeUserGroupId(value, fallbackName = 'group') {
  const raw = String(value || '').trim()
  const id = raw ? slugify(raw, 'group') : `group-${slugify(fallbackName, 'user')}-${crypto.randomBytes(3).toString('hex')}`
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id)) throw new Error('分组 ID 只能使用 2-63 位小写字母、数字、横线或下划线')
  return id
}

async function upsertUserGroup(input = {}, context = null) {
  const name = String(input.name || '').trim().slice(0, 80)
  if (!name) throw new Error('分组名称不能为空')
  const id = safeUserGroupId(input.id, name)
  const existing = await findUserGroupById(id)
  if (existing && existing.organizationId !== (context?.organizationId || '')) throw new Error('不能修改其他组织的账号分组')
  const description = String(input.description || '').trim().slice(0, 255)
  const status = input.status === 'disabled' ? 'disabled' : 'enabled'
  const sortOrder = Number.isFinite(Number(input.sortOrder)) ? Math.floor(Number(input.sortOrder)) : 0
  await db().query(
    `INSERT INTO ai_user_groups (id, organization_id, name, description, status, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       description = VALUES(description),
       status = VALUES(status),
       sort_order = VALUES(sort_order)`,
    [id, context?.organizationId || '', name, description, status, sortOrder],
  )
  return findUserGroupById(id, context)
}

async function deleteUserGroup(id, context = null) {
  const group = await findUserGroupById(id, context)
  if (!group) throw new Error('账号分组不存在')
  if (group.memberCount > 0) throw new Error('该分组下仍有成员，不能删除')
  await db().query('DELETE FROM ai_user_groups WHERE id = ?', [group.id])
  return { id: group.id, deleted: true }
}

async function listUserGroupMembers(groupId, context = null) {
  const group = await findUserGroupById(groupId, context)
  if (!group) throw new Error('账号分组不存在')
  const [rows] = await db().query(
    `SELECT u.*
     FROM ai_user_group_members m
     JOIN ai_users u ON u.id = m.user_id
     WHERE m.group_id = ?
     ORDER BY u.created_at DESC`,
    [group.id],
  )
  return { group, users: rows.map(normalizeUser).map(sanitizeUser), userIds: rows.map((row) => row.id) }
}

async function saveUserGroupMembers(groupId, userIds = [], context = null) {
  const group = await findUserGroupById(groupId, context)
  if (!group) throw new Error('账号分组不存在')
  const uniqueIds = [...new Set((Array.isArray(userIds) ? userIds : []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (uniqueIds.length > 200) throw new Error('单个分组成员数量不能超过 200')
  if (uniqueIds.length > 0) {
    const [rows] = await db().query(
      `SELECT id FROM ai_users WHERE primary_organization_id=? AND id IN (${uniqueIds.map(() => '?').join(',')})`,
      [group.organizationId, ...uniqueIds],
    )
    const existing = new Set(rows.map((row) => row.id))
    const missing = uniqueIds.filter((id) => !existing.has(id))
    if (missing.length > 0) throw new Error(`以下账号不存在：${missing.join(', ')}`)
  }
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    await connection.query('DELETE FROM ai_user_group_members WHERE group_id = ?', [group.id])
    for (const userId of uniqueIds) {
      await connection.query('INSERT INTO ai_user_group_members (group_id, user_id) VALUES (?, ?)', [group.id, userId])
    }
    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
  return listUserGroupMembers(group.id, context)
}

function permissionCatalogKeySet() {
  return accessControl.permissionCatalogKeySet()
}

function permissionCatalogItems() {
  return accessControl.permissionCatalogItems()
}

function permissionByKey(key) {
  return accessControl.permissionByKey(key)
}

function roleCanUsePermission(role, permission) {
  return accessControl.roleCanUsePermission(role, permission)
}

async function supplierCanUsePermission(permission) {
  if (!permission) return false
  if (permission.officialCenterOnly && !CENTER_SUPPLIER_MANAGEMENT_ENABLED) return false
  return supplierLicenseAllowsPermission(permission, CENTER_SUPPLIER_MANAGEMENT_ENABLED ? null : await getSupplierLicense(), CENTER_SUPPLIER_MANAGEMENT_ENABLED)
}

async function listAssignedUserPermissionKeys(userId) {
  const [rows] = await db().query(
    `SELECT DISTINCT p.permission_key
     FROM ai_user_group_members m
     JOIN ai_user_groups g ON g.id = m.group_id AND g.status = 'enabled'
     JOIN ai_user_group_permissions p ON p.group_id = g.id
     WHERE m.user_id = ?
     ORDER BY p.permission_key ASC`,
    [String(userId || '').trim()],
  )
  return rows.map((row) => row.permission_key)
}

async function hasEnabledUserGroup(userId) {
  const [[row]] = await db().query(
    `SELECT COUNT(*) AS total
     FROM ai_user_group_members m
     JOIN ai_user_groups g ON g.id = m.group_id AND g.status = 'enabled'
     WHERE m.user_id = ?`,
    [String(userId || '').trim()],
  )
  return Number(row?.total || 0) > 0
}

function safeRoleTemplateId(value, fallbackName = 'template') {
  const raw = String(value || '').trim()
  const id = raw ? slugify(raw, 'template') : `template-${slugify(fallbackName, 'role')}-${crypto.randomBytes(3).toString('hex')}`
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id)) throw new Error('角色模板 ID 只能使用 2-63 位小写字母、数字、横线或下划线')
  return id
}

async function listRoleTemplates(context = null) {
  const [rows] = context?.organizationId
    ? await db().query("SELECT * FROM ai_role_templates WHERE organization_id='' OR organization_id=? ORDER BY sort_order ASC, created_at ASC", [context.organizationId])
    : await db().query('SELECT * FROM ai_role_templates ORDER BY sort_order ASC, created_at ASC')
  if (rows.length === 0) return []
  const [permissionRows] = await db().query('SELECT template_id, permission_key FROM ai_role_template_permissions ORDER BY permission_key ASC')
  const map = new Map()
  for (const row of permissionRows) {
    if (!map.has(row.template_id)) map.set(row.template_id, [])
    map.get(row.template_id).push(row.permission_key)
  }
  const canManageBuiltins = canManageBuiltinRoleTemplates(context)
  return rows.map((row) => {
    const template = normalizeRoleTemplate(row, map.get(row.id) || [])
    return {
      ...template,
      editable: !template.systemBuiltin || canManageBuiltins,
      deletable: !template.systemBuiltin || canManageBuiltins,
    }
  })
}

async function findRoleTemplateById(id) {
  const [rows] = await db().query('SELECT * FROM ai_role_templates WHERE id = ? LIMIT 1', [String(id || '').trim()])
  if (!rows[0]) return null
  const [permissionRows] = await db().query('SELECT permission_key FROM ai_role_template_permissions WHERE template_id = ? ORDER BY permission_key ASC', [rows[0].id])
  return normalizeRoleTemplate(rows[0], permissionRows.map((row) => row.permission_key))
}

async function seedDefaultRoleTemplates() {
  const allowed = permissionCatalogKeySet()
  const [deletedRows] = await db().query('SELECT template_id FROM ai_deleted_builtin_role_templates')
  const deletedIds = new Set(deletedRows.map((row) => row.template_id))
  for (const template of DEFAULT_ROLE_TEMPLATES) {
    const id = safeRoleTemplateId(template.id, template.name)
    if (deletedIds.has(id)) continue
    const [inserted] = await db().query(
      `INSERT INTO ai_role_templates (id, name, description, base_role, status, sort_order, system_builtin)
       VALUES (?, ?, ?, ?, 'enabled', ?, 1)
       ON DUPLICATE KEY UPDATE id = id`,
      [id, template.name, template.description, template.baseRole === 'admin' ? 'admin' : 'agent', Number(template.sortOrder || 0)],
    )
    if (Number(inserted?.affectedRows || 0) === 0) continue
    const keys = [...new Set((template.permissionKeys || []).filter((key) => allowed.has(key)))]
    for (const key of keys) {
      await db().query('INSERT IGNORE INTO ai_role_template_permissions (template_id, permission_key) VALUES (?, ?)', [id, key])
    }
  }
  // Grant newly introduced message permissions once to existing built-in roles.
  // Subsequent administrator edits must not be overwritten on every startup.
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    const [migration] = await connection.query("INSERT IGNORE INTO ai_feature_migrations (migration_key) VALUES ('client-notices-v1')")
    if (Number(migration.affectedRows || 0) > 0) {
      for (const templateId of ['supplier-admin', 'agent-operator', 'operations']) {
        for (const permission of ['client_notices.view', 'client_notices.publish']) {
          await connection.query(`INSERT IGNORE INTO ai_role_template_permissions (template_id,permission_key)
            SELECT id,? FROM ai_role_templates WHERE id=? AND system_builtin=1`, [permission, templateId])
        }
      }
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
}

async function upsertRoleTemplate(input = {}, context = null) {
  if (canManageBuiltinRoleTemplates(context)) context = { ...context, dataScope: 'platform' }
  const name = String(input.name || '').trim().slice(0, 80)
  if (!name) throw new Error('角色模板名称不能为空')
  const id = safeRoleTemplateId(input.id, name)
  const existing = await findRoleTemplateById(id)
  if (existing?.systemBuiltin && context?.dataScope !== 'platform') throw new Error('系统内置角色模板不能在下级组织直接修改，请新建自定义模板')
  if (existing && !existing.systemBuiltin && existing.organizationId !== (context?.organizationId || '')) throw new Error('不能修改其他组织的角色模板')
  const description = String(input.description || '').trim().slice(0, 255)
  const requestedBaseRole = input.baseRole ?? input.base_role
  const baseRole = requestedBaseRole == null ? (existing?.baseRole || 'agent') : (requestedBaseRole === 'admin' ? 'admin' : 'agent')
  const status = input.status === 'disabled' ? 'disabled' : 'enabled'
  const sortOrder = Number.isFinite(Number(input.sortOrder)) ? Math.floor(Number(input.sortOrder)) : 0
  await db().query(
    `INSERT INTO ai_role_templates (id, organization_id, name, description, base_role, status, sort_order, system_builtin)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       description = VALUES(description),
       base_role = VALUES(base_role),
       status = VALUES(status),
       sort_order = VALUES(sort_order)`,
    [id, context?.organizationId || '', name, description, baseRole, status, sortOrder],
  )
  return findRoleTemplateById(id)
}

async function saveRoleTemplatePermissions(templateId, permissionKeys = [], context = null) {
  if (canManageBuiltinRoleTemplates(context)) context = { ...context, dataScope: 'platform' }
  const template = await findRoleTemplateById(templateId)
  if (!template) throw new Error('角色模板不存在')
  if (template.systemBuiltin && context?.dataScope !== 'platform') throw new Error('系统内置角色模板不能在下级组织直接修改，请新建自定义模板')
  if (!template.systemBuiltin && template.organizationId !== (context?.organizationId || '')) throw new Error('不能修改其他组织的角色模板')
  const allowed = permissionCatalogKeySet()
  const uniqueKeys = [...new Set((Array.isArray(permissionKeys) ? permissionKeys : []).map((key) => String(key || '').trim()).filter(Boolean))]
  const invalid = uniqueKeys.filter((key) => !allowed.has(key))
  if (invalid.length > 0) throw new Error(`未知权限点：${invalid.join(', ')}`)
  const usableKeys = uniqueKeys
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    await connection.query('DELETE FROM ai_role_template_permissions WHERE template_id = ?', [template.id])
    for (const key of usableKeys) {
      await connection.query('INSERT INTO ai_role_template_permissions (template_id, permission_key) VALUES (?, ?)', [template.id, key])
    }
    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
  return findRoleTemplateById(template.id)
}

async function deleteRoleTemplate(templateId, context = null) {
  if (canManageBuiltinRoleTemplates(context)) context = { ...context, dataScope: 'platform' }
  const template = await findRoleTemplateById(templateId)
  if (!template) throw Object.assign(new Error('岗位模板不存在'), { statusCode: 404 })
  if (template.systemBuiltin && context?.dataScope !== 'platform') throw Object.assign(new Error('只有平台管理员可以删除系统内置岗位'), { statusCode: 403 })
  if (!template.systemBuiltin && template.organizationId !== (context?.organizationId || '')) throw Object.assign(new Error('不能删除其他组织的岗位模板'), { statusCode: 403 })
  const [[userRows], [memberRows]] = await Promise.all([
    db().query('SELECT COUNT(*) AS total FROM ai_users WHERE role_template_id = ?', [template.id]),
    db().query('SELECT COUNT(*) AS total FROM ai_organization_members WHERE role_template_id = ?', [template.id]),
  ])
  const usageCount = Number(userRows?.[0]?.total || 0) + Number(memberRows?.[0]?.total || 0)
  if (usageCount > 0) throw Object.assign(new Error(`该岗位仍被 ${usageCount} 个后台账号使用，请先为这些账号调整岗位`), { statusCode: 409 })
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    if (template.systemBuiltin) await connection.query('INSERT IGNORE INTO ai_deleted_builtin_role_templates (template_id) VALUES (?)', [template.id])
    await connection.query('DELETE FROM ai_role_templates WHERE id = ?', [template.id])
    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
  return { id: template.id, deleted: true }
}

async function listRoleTemplatePermissionKeys(templateId) {
  if (!templateId) return []
  const template = await findRoleTemplateById(templateId)
  if (!template || template.status === 'disabled') return []
  return template.permissionKeys || []
}

function defaultRoleTemplateId(role) {
  return role === 'admin' ? 'supplier-admin' : 'agent-operator'
}

async function resolveRoleTemplateForUser(user) {
  if (!user) return null
  const templateId = String(user.roleTemplateId || '').trim() || defaultRoleTemplateId(user.role)
  if (!templateId) return null
  return findRoleTemplateById(templateId)
}

async function listUserPermissionGroups(userId) {
  const [rows] = await db().query(
    `SELECT g.*, p.permission_key
     FROM ai_user_group_members m
     JOIN ai_user_groups g ON g.id = m.group_id
     LEFT JOIN ai_user_group_permissions p ON p.group_id = g.id
     WHERE m.user_id = ?
     ORDER BY g.sort_order ASC, g.created_at ASC, p.permission_key ASC`,
    [String(userId || '').trim()],
  )
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.id)) map.set(row.id, { group: normalizeUserGroup(row), permissionKeys: [] })
    if (row.permission_key) map.get(row.id).permissionKeys.push(row.permission_key)
  }
  return [...map.values()]
}

async function getUserPermissionPreview(userId, context = null) {
  const user = await findUserById(userId)
  if (!user) throw new Error('后台账号不存在')
  if (context?.dataScope !== 'platform' && user.primaryOrganizationId !== context?.organizationId) throw new Error('不能查看其他组织账号的权限')
  const roleTemplate = await resolveRoleTemplateForUser(user)
  const usesDefaultTemplate = !String(user.roleTemplateId || '').trim() && Boolean(roleTemplate)
  const groups = await listUserPermissionGroups(user.id)
  const assignedKeys = await listAssignedUserPermissionKeys(user.id)
  const hasGroup = groups.some((item) => item.group?.status === 'enabled')
  const templateKeys = roleTemplate?.status === 'enabled' ? roleTemplate.permissionKeys || [] : []
  const fallbackRoleKeys = permissionCatalogItems().map((item) => item.key)
  const sourceKeys = hasGroup ? assignedKeys : (roleTemplate ? templateKeys : fallbackRoleKeys)
  const effectiveKeys = await getEffectivePermissionKeys(user)
  const targetOrganizationContext = await buildOrganizationContext(user, organizationRepository, { getSupplierLicense })
  return {
    user: sanitizeUser(user),
    sourceMode: hasGroup ? 'group' : (roleTemplate ? (usesDefaultTemplate ? 'default-template' : 'template') : 'role-default'),
    roleTemplate,
    groups,
    sourcePermissionKeys: [...new Set(sourceKeys)].sort(),
    effectivePermissionKeys: effectiveKeys,
    organizationContext: targetOrganizationContext,
  }
}

async function getEffectivePermissionKeys(user) {
  if (!user) return []
  const assignedKeys = await listAssignedUserPermissionKeys(user.id)
  const roleTemplate = await resolveRoleTemplateForUser(user)
  const keys = await accessControl.resolveEffectivePermissionKeys({
    user,
    assignedKeys,
    hasEnabledGroup: await hasEnabledUserGroup(user.id),
    roleTemplate,
    canUsePermission: supplierCanUsePermission,
  })
  const context = user.organizationContext || await buildOrganizationContext(user, organizationRepository, { getSupplierLicense })
  return filterOrganizationPermissions(keys, context)
}

async function listUserGroupPermissions(groupId, context = null) {
  const group = await findUserGroupById(groupId, context)
  if (!group) throw new Error('账号分组不存在')
  const [rows] = await db().query(
    'SELECT permission_key FROM ai_user_group_permissions WHERE group_id = ? ORDER BY permission_key ASC',
    [group.id],
  )
  return { group, permissionKeys: rows.map((row) => row.permission_key) }
}

async function saveUserGroupPermissions(groupId, permissionKeys = [], context = null) {
  const group = await findUserGroupById(groupId, context)
  if (!group) throw new Error('账号分组不存在')
  const allowed = permissionCatalogKeySet()
  const uniqueKeys = [...new Set((Array.isArray(permissionKeys) ? permissionKeys : []).map((key) => String(key || '').trim()).filter(Boolean))]
  const invalid = uniqueKeys.filter((key) => !allowed.has(key))
  if (invalid.length > 0) throw new Error(`未知权限点：${invalid.join(', ')}`)
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    await connection.query('DELETE FROM ai_user_group_permissions WHERE group_id = ?', [group.id])
    for (const key of uniqueKeys) {
      await connection.query('INSERT INTO ai_user_group_permissions (group_id, permission_key) VALUES (?, ?)', [group.id, key])
    }
    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
  return listUserGroupPermissions(group.id, context)
}

async function upsertUser(input, existingUser = null, organizationContext = null) {
  const username = safeUsername(input.username || existingUser?.username)
  if (existingUser && username !== existingUser.username) throw new Error('编辑账号时不能修改登录账号')
  const displayName = String(input.displayName || username).trim()
  const roleTemplateId = String(input.roleTemplateId || input.role_template_id || existingUser?.roleTemplateId || '').trim()
  const status = input.status === 'disabled' ? 'disabled' : 'enabled'
  const maxProjects = parseLimit(input.maxProjects ?? existingUser?.maxProjects)
  const maxBuilds = parseLimit(input.maxBuilds ?? existingUser?.maxBuilds)
  const password = String(input.password || '')
  const id = existingUser?.id || crypto.randomUUID()
  const organizationId = existingUser?.primaryOrganizationId || organizationContext?.organizationId || ''
  if (!organizationId) throw new Error('当前账号尚未归属组织，不能新增内部成员')
  if (!roleTemplateId) throw new Error('请选择角色模板')
  const template = await findRoleTemplateById(roleTemplateId)
  if (!template || template.status === 'disabled') throw new Error('角色模板不存在或已停用')
  if (!template.systemBuiltin && template.organizationId !== organizationId) throw new Error('不能使用其他组织的角色模板')
  const role = 'admin'
  const requestedDataScope = existingUser?.dataScope || 'self'
  if (requestedDataScope === 'platform' && organizationContext?.dataScope !== 'platform') throw new Error('只有官方平台主体可以授予全平台数据范围')
  if (requestedDataScope === 'subtree' && !['platform', 'subtree'].includes(organizationContext?.dataScope)) throw new Error('当前岗位不能转授全部下级数据范围')
  if (requestedDataScope === 'children' && Number(organizationContext?.organizationLevel || 0) >= 2) throw new Error('二级代理没有直属下级数据范围')
  let passwordHash = existingUser?.passwordHash || ''
  if (password) {
    if (password.length < 8) throw new Error('密码至少 8 位')
    passwordHash = hashPassword(password)
  } else if (!passwordHash) {
    throw new Error('新账号必须设置密码')
  }
  try {
    await db().query(
      `INSERT INTO ai_users (id, username, display_name, role, role_template_id, primary_organization_id, status, max_projects, max_builds, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         role = VALUES(role),
         role_template_id = VALUES(role_template_id),
         primary_organization_id = VALUES(primary_organization_id),
         status = VALUES(status),
         max_projects = VALUES(max_projects),
         max_builds = VALUES(max_builds),
         password_hash = VALUES(password_hash)`,
      [id, username, displayName, role, roleTemplateId, organizationId, status, maxProjects, maxBuilds, passwordHash],
    )
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') throw new Error('账号已存在')
    throw err
  }
  await db().query(
    `INSERT INTO ai_organization_members
      (organization_id, user_id, role_template_id, data_scope, status, is_owner, created_by)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON DUPLICATE KEY UPDATE role_template_id=VALUES(role_template_id), data_scope=VALUES(data_scope), status=VALUES(status)`,
    [organizationId, id, roleTemplateId || defaultRoleTemplateId(role),
      organizationContext ? requestedDataScope : 'self', status,
      organizationContext?.actorUserId || 'system'],
  )
  await ensureAccountFreeMembership(id)
  return findUserById(id)
}

function assertCanManageUser(actor, targetUser, input = {}) {
  const actorIsSuperAdmin = isSuperAdminUser(actor)
  const targetIsSuperAdmin = isSuperAdminUser(targetUser)
  const requestedUsername = input?.username ? safeUsername(input.username) : ''
  const requestedIsSuperAdmin = requestedUsername ? isSuperAdminUsername(requestedUsername) : false

  if (targetIsSuperAdmin && !actorIsSuperAdmin) {
    throw new Error('内置超级管理员 admin 受保护，只有 admin 本人可以修改')
  }
  if (!targetUser && requestedIsSuperAdmin) {
    throw new Error('admin 是内置超级管理员账号，不能新建或覆盖')
  }
  if (!targetIsSuperAdmin && requestedIsSuperAdmin) {
    throw new Error('不能将其他账号改名为 admin')
  }
  if (targetIsSuperAdmin) {
    const nextRole = input?.role === 'admin' ? 'admin' : 'agent'
    const nextStatus = input?.status === 'disabled' ? 'disabled' : 'enabled'
    if (nextRole !== 'admin') throw new Error('内置超级管理员不能降级为代理商')
    if (nextStatus !== 'enabled') throw new Error('内置超级管理员不能停用')
  }
}

async function findCenterSupplierById(id) {
  const [rows] = await db().query('SELECT * FROM ai_center_suppliers WHERE id = ? LIMIT 1', [safeCenterId(id, '供应商 ID')])
  return rows[0] || null
}

async function listCenterSuppliers() {
  const [rows] = await db().query('SELECT * FROM ai_center_suppliers ORDER BY created_at DESC')
  return Promise.all(rows.map((row) => supplierLicensePayload(row)))
}

function deploymentConfigForSupplier(supplier, plainToken = '') {
  return [
    `AI_BUILD_CENTER_URL=${normalizeSecureBuildCenterUrl(BUILD_CENTER_PUBLIC_URL, { allowEmpty: false })}`,
    `AI_BUILD_CENTER_SUPPLIER_ID=${supplier.id}`,
    `AI_BUILD_CENTER_TOKEN=${plainToken || '<请在创建或重置时复制 token>'}`,
  ].join('\n')
}

async function getCenterSupplierUsage(supplierId) {
  const [[supplier]] = await db().query(
    'SELECT project_registry_initialized FROM ai_center_suppliers WHERE id = ? LIMIT 1',
    [supplierId],
  )
  const [[projectRow]] = supplier?.project_registry_initialized
    ? await db().query('SELECT COUNT(*) AS project_count FROM ai_center_supplier_projects WHERE supplier_id = ?', [supplierId])
    : await db().query('SELECT COUNT(DISTINCT project_id) AS project_count FROM ai_builds WHERE center_supplier_id = ?', [supplierId])
  const [[buildRow]] = await db().query('SELECT COUNT(*) AS build_count FROM ai_builds WHERE center_supplier_id = ?', [supplierId])
  return {
    projects: Number(projectRow?.project_count || 0),
    builds: Number(buildRow?.build_count || 0),
    projectsSynced: Boolean(supplier?.project_registry_initialized),
  }
}

async function initializeCenterSupplierProjectRegistry(supplier, projectIds = null) {
  if (!Array.isArray(projectIds)) return
  const supplierId = safeCenterId(supplier?.id || '', '供应商 ID')
  const normalizedIds = normalizeSupplierProjectIds(projectIds)
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query(
      'SELECT project_registry_initialized FROM ai_center_suppliers WHERE id = ? LIMIT 1 FOR UPDATE',
      [supplierId],
    )
    if (!rows[0]) throw new Error('供应商不存在')
    if (!rows[0].project_registry_initialized) {
      await conn.query('DELETE FROM ai_center_supplier_projects WHERE supplier_id = ?', [supplierId])
      for (const projectId of normalizedIds) {
        await conn.query(
          'INSERT IGNORE INTO ai_center_supplier_projects (supplier_id, project_id) VALUES (?, ?)',
          [supplierId, projectId],
        )
      }
      await conn.query('UPDATE ai_center_suppliers SET project_registry_initialized = 1 WHERE id = ?', [supplierId])
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

async function reserveCenterSupplierProject(supplier, projectId, knownProjectIds = []) {
  const supplierId = safeCenterId(supplier?.id || '', '供应商 ID')
  const normalizedProjectId = safeProjectId(projectId)
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    const [supplierRows] = await conn.query(
      'SELECT max_projects, project_registry_initialized FROM ai_center_suppliers WHERE id = ? LIMIT 1 FOR UPDATE',
      [supplierId],
    )
    const lockedSupplier = supplierRows[0]
    if (!lockedSupplier) throw new Error('供应商不存在')
    const [registeredRows] = lockedSupplier.project_registry_initialized
      ? await conn.query('SELECT project_id FROM ai_center_supplier_projects WHERE supplier_id = ? ORDER BY project_id', [supplierId])
      : [[]]
    const plannedProjectIds = planSupplierProjectReservation({
      registeredProjectIds: registeredRows.map((row) => row.project_id),
      knownProjectIds,
      projectId: normalizedProjectId,
      maxProjects: lockedSupplier.max_projects,
    })
    if (!lockedSupplier.project_registry_initialized) {
      await conn.query('DELETE FROM ai_center_supplier_projects WHERE supplier_id = ?', [supplierId])
    }
    for (const id of plannedProjectIds) {
      await conn.query(
        'INSERT IGNORE INTO ai_center_supplier_projects (supplier_id, project_id) VALUES (?, ?)',
        [supplierId, id],
      )
    }
    await conn.query('UPDATE ai_center_suppliers SET project_registry_initialized = 1 WHERE id = ?', [supplierId])
    await conn.commit()
    return { projectId: normalizedProjectId, usedProjects: plannedProjectIds.length, maxProjects: Number(lockedSupplier.max_projects || 0) }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

async function releaseCenterSupplierProject(supplier, projectId, knownProjectIds = []) {
  const supplierId = safeCenterId(supplier?.id || '', '供应商 ID')
  const normalizedProjectId = safeProjectId(projectId)
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    const [supplierRows] = await conn.query(
      'SELECT project_registry_initialized FROM ai_center_suppliers WHERE id = ? LIMIT 1 FOR UPDATE',
      [supplierId],
    )
    const lockedSupplier = supplierRows[0]
    if (!lockedSupplier) throw new Error('供应商不存在')
    if (!lockedSupplier.project_registry_initialized) {
      for (const id of normalizeSupplierProjectIds(knownProjectIds).filter((id) => id !== normalizedProjectId)) {
        await conn.query(
          'INSERT IGNORE INTO ai_center_supplier_projects (supplier_id, project_id) VALUES (?, ?)',
          [supplierId, id],
        )
      }
      await conn.query('UPDATE ai_center_suppliers SET project_registry_initialized = 1 WHERE id = ?', [supplierId])
    } else {
      await conn.query(
        'DELETE FROM ai_center_supplier_projects WHERE supplier_id = ? AND project_id = ?',
        [supplierId, normalizedProjectId],
      )
    }
    const [[usage]] = await conn.query('SELECT COUNT(*) AS count FROM ai_center_supplier_projects WHERE supplier_id = ?', [supplierId])
    await conn.commit()
    return { projectId: normalizedProjectId, released: true, usedProjects: Number(usage?.count || 0) }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

async function supplierLicensePayload(supplier, projectIds = null) {
  const normalized = normalizeCenterSupplier(supplier)
  if (normalized?.authorizationStatus === 'enabled' && Array.isArray(projectIds)) await initializeCenterSupplierProjectRegistry(normalized, projectIds)
  const usage = normalized ? await getCenterSupplierUsage(normalized.id) : { projects: 0, builds: 0 }
  const capabilities = normalized ? await organizationRepository.listOrganizationCapabilities(normalized.organizationId) : []
  return {
    ...normalized,
    capabilities,
    usedProjects: usage.projects,
    usedBuilds: usage.builds,
    projectUsageSynced: usage.projectsSynced,
    message: normalized?.authorizationStatus === 'expired' ? '供应商授权已到期，请联系上级续期'
      : normalized?.status === 'enabled' ? '授权正常' : '供应商授权已停用',
  }
}

function centerSupplierOrganizationCapabilities(supplier) {
  const normalized = supplier?.allowAgentManagement === undefined
    ? normalizeCenterSupplier(supplier)
    : supplier
  const flags = {
    allowAgentManagement: Boolean(normalized?.allowAgentManagement),
    allowSupplierManagement: Boolean(normalized?.allowSupplierManagement),
    allowPlatformSettings: Boolean(normalized?.allowPlatformSettings),
    allowCustomBrand: Boolean(normalized?.allowCustomBrand),
    allowCustomApiProviders: Boolean(normalized?.allowCustomApiProviders),
  }
  const nonTransferable = new Set([
    'organizations.children.manage', 'organizations.capabilities.manage', 'center_suppliers.manage',
    'platform_settings.manage', 'self_update.manage', 'diagnostics.view', 'authorization.view',
  ])
  return permissionCatalogItems().filter((permission) => {
    if (permission.officialCenterOnly) return flags.allowSupplierManagement
    return !permission.supplierAbility || flags[permission.supplierAbility]
  }).map((permission) => ({
    key: permission.key,
    enabled: true,
    transferable: !nonTransferable.has(permission.key),
    limitValue: permission.key === 'projects.manage'
      ? Number(normalized?.maxProjects || 0)
      : (permission.key === 'builds.create' ? Number(normalized?.maxBuilds || 0) : 0),
    config: {},
  }))
}

function organizationCapabilitySignature(capabilities) {
  return JSON.stringify((capabilities || []).map((item) => [
    item.key,
    item.enabled !== false,
    Boolean(item.transferable),
    Number(item.limitValue || 0),
  ]).sort((left, right) => left[0].localeCompare(right[0])))
}

async function replaceOrganizationCapabilitiesWithDeadlockRetry(organizationId, capabilities, actor) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await organizationRepository.replaceOrganizationCapabilities(organizationId, capabilities, actor)
    } catch (err) {
      lastError = err
      if (err?.code !== 'ER_LOCK_DEADLOCK' || attempt === 3) throw err
      await new Promise((resolve) => setTimeout(resolve, attempt * 100))
    }
  }
  throw lastError
}

async function reconcileCenterSupplierOrganizations() {
  if (!CENTER_SUPPLIER_MANAGEMENT_ENABLED) return
  const [rows] = await db().query('SELECT * FROM ai_center_suppliers ORDER BY created_at ASC')
  for (const row of rows) {
    const supplier = normalizeCenterSupplier(row)
    await organizationRepository.upsertFirstLevelOrganization({
      id: supplier.id,
      externalId: supplier.id,
      name: supplier.name,
      status: supplier.status,
      authorizationVersion: supplier.authorizationVersion,
    }, { organizationId: 'platform', userId: 'system-migration' })
    const expected = centerSupplierOrganizationCapabilities(supplier)
    const current = await organizationRepository.listOrganizationCapabilities(supplier.id)
    if (organizationCapabilitySignature(current) !== organizationCapabilitySignature(expected)) {
      await replaceOrganizationCapabilitiesWithDeadlockRetry(
        supplier.id,
        expected,
        { organizationId: 'platform', userId: 'system-migration' },
      )
    }
  }
}

const { upsertCenterSupplier } = createCenterSupplierAuthorizationService({
  organizationRepository, findCenterSupplierById, deploymentConfigForSupplier, centerSupplierOrganizationCapabilities,
})

async function resetCenterSupplierToken(id) {
  const supplier = await findCenterSupplierById(id)
  if (!supplier) throw new Error('供应商不存在')
  const plainToken = createSecretToken()
  await db().query(
    'UPDATE ai_center_suppliers SET token_hash = ?, token_preview = ? WHERE id = ?',
    [hashSecretToken(plainToken), plainToken.slice(-8), supplier.id],
  )
  const saved = normalizeCenterSupplier(await findCenterSupplierById(supplier.id))
  return {
    ...saved,
    token: plainToken,
    deploymentConfig: deploymentConfigForSupplier(saved, plainToken),
  }
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) {
    throw new Error('璇疯緭鍏ユ湁鏁堢殑閭鍦板潃')
  }
  return email
}


async function findEndUserByUsername(username) {
  const [rows] = await db().query('SELECT * FROM ai_end_users WHERE username = ? LIMIT 1', [safeEndUsername(username)])
  const user = normalizeEndUser(rows[0])
  if (user && rows[0]?.password_hash) user.passwordHash = rows[0].password_hash
  return user
}

async function findEndUserByEmail(email) {
  const [rows] = await db().query('SELECT * FROM ai_end_users WHERE email = ? LIMIT 1', [normalizeEmail(email)])
  const user = normalizeEndUser(rows[0])
  if (user && rows[0]?.password_hash) user.passwordHash = rows[0].password_hash
  return user
}

async function findEndUserById(id) {
  const [rows] = await db().query('SELECT * FROM ai_end_users WHERE id = ? LIMIT 1', [String(id || '')])
  const user = normalizeEndUser(rows[0])
  if (user && rows[0]?.password_hash) user.passwordHash = rows[0].password_hash
  return user
}

async function ensureEndUserMembershipFallback(userId, preferredOwnerUserId = '') {
  const id = String(userId || '').trim()
  if (!id) return null
  const [[active]] = await db().query(
    `SELECT id, card_id, package_name, started_at, expires_at, points_expires_at, status, source, created_by
     FROM ai_end_user_memberships
     WHERE user_id = ? AND status = 'active'
       AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(3))
     ORDER BY created_at DESC LIMIT 1`,
    [id],
  )
  if (active?.id) return { ...active, existing: true }
  const resolvedOwnerId = String(preferredOwnerUserId || await keyOwnerUserIdForEndUser(id) || 'admin')
  const owner = await findUserById(resolvedOwnerId)
  return ensureFreeMembershipFallback({ userId: id, ownerUserId: owner?.id || 'admin' })
}

async function findEndUserWithMembershipById(id) {
  const targetUserId = String(id || '').trim()
  if (!targetUserId || !await findEndUserById(targetUserId)) return null
  await ensureEndUserMembershipFallback(targetUserId)
  const [rows] = await db().query(
    `SELECT u.*,
      (SELECT COUNT(*) FROM ai_end_user_model_access a WHERE a.user_id = u.id) AS allowed_model_count,
      m.id AS membership_id,
      m.card_id AS membership_card_id,
      m.package_name AS membership_package_name,
      m.started_at AS membership_started_at,
      m.expires_at AS membership_expires_at,
      m.points_expires_at AS membership_points_expires_at,
      m.status AS membership_status,
      c.name AS membership_card_name,
      c.level AS membership_card_level,
      (SELECT COUNT(*) FROM ai_membership_card_model_access ma WHERE ma.card_id = m.card_id) AS membership_allowed_model_count
     FROM ai_end_users u
     LEFT JOIN ai_end_user_memberships m
       ON m.id = (
         SELECT mm.id
         FROM ai_end_user_memberships mm
         WHERE mm.user_id = u.id
           AND mm.status = 'active'
           AND (mm.expires_at IS NULL OR mm.expires_at > CURRENT_TIMESTAMP(3))
         ORDER BY mm.created_at DESC
         LIMIT 1
       )
     LEFT JOIN ai_membership_cards c ON c.id = m.card_id
     WHERE u.id = ?
     LIMIT 1`,
    [targetUserId],
  )
  const user = normalizeEndUser(rows[0])
  if (user && rows[0]?.password_hash) user.passwordHash = rows[0].password_hash
  return user
}

async function appendEndUserEvent(userId, eventType, payload = {}) {
  await db().query(
    'INSERT INTO ai_end_user_events (id, user_id, event_type, payload_json) VALUES (?, ?, ?, ?)',
    [crypto.randomUUID(), userId, String(eventType || '').slice(0, 64), JSON.stringify(payload || {})],
  )
}

async function createEndUserSession(user, input = {}) {
  const token = createSecretToken()
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
  await db().query(
    'INSERT INTO ai_end_user_sessions (token_hash, user_id, device_id, expires_at, project_id) VALUES (?, ?, ?, ?, ?)',
    [hashSecretToken(token), user.id, normalizeSourceText(input.deviceId, 160), expiresAt, normalizeSourceText(input.sourceProjectId, 80)],
  )
  return token
}

async function getEndUserByToken(token) {
  const tokenHash = hashSecretToken(token)
  const [rows] = await db().query(
    `SELECT u.*, s.device_id AS session_device_id, s.project_id AS session_project_id
     FROM ai_end_user_sessions s
     JOIN ai_end_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP(3)
     LIMIT 1`,
    [tokenHash],
  )
  const user = normalizeEndUser(rows[0])
  if (user) Object.defineProperty(user, 'clientProjectId', { value: rows[0].session_project_id || '', enumerable: false })
  return user
}

async function registerEndUser(input = {}) {
  await clientProjectPolicy.assertRegistration(input)
  const username = safeEndUsername(input.username)
  const email = normalizeEmail(input.email)
  const password = String(input.password || '')
  if (password.length < 6) throw new Error('密码至少 6 位')
  const existing = await findEndUserByUsername(username)
  if (existing) throw new Error('该账号已注册，请直接登录')

  const existingEmail = await findEndUserByEmail(email)
  if (existingEmail) throw new Error('璇ラ偖绠卞凡琚敞鍐岋紝璇风洿鎺ョ櫥褰曟垨鎵惧洖瀵嗙爜')

  await verifyEndUserRegistrationCode({ ...input, username, email })

  const id = crypto.randomUUID()
  const displayName = String(input.displayName || username).trim().slice(0, 120)
  const sourceSupplierId = normalizeSourceText(input.sourceSupplierId || input.supplierId, 80)
  const sourceAgentId = normalizeSourceText(input.sourceAgentId || input.agentId, 80)
  const sourceProjectId = normalizeSourceText(input.sourceProjectId || input.aiProjectId || input.projectId, 80)
  const sourceBuildId = normalizeSourceText(input.sourceBuildId || input.buildId, 120)
  const centerProjectIdValue = normalizeSourceText(input.centerProjectId, 80)
  const channelCode = normalizeSourceText(input.channelCode, 120)
  const appVersion = normalizeSourceText(input.appVersion, 64)
  const deviceId = normalizeSourceText(input.deviceId, 160)
  const deviceName = normalizeSourceText(input.deviceName, 160)
  const settings = await getPlatformSettings('platform')
  const defaultModelPointsPerUsd = Math.max(0, Number(settings.modelPointsPerUsd || defaultPlatformSettings.modelPointsPerUsd))
  const [[sourceOrganization]] = await db().query(
    `SELECT o.id FROM ai_organizations o
     LEFT JOIN ai_projects p ON p.id=?
     WHERE o.legacy_owner_user_id=COALESCE(NULLIF(?,''), p.owner_user_id, 'admin') LIMIT 1`,
    [sourceProjectId, sourceAgentId],
  )

  await db().query(
    `INSERT INTO ai_end_users (
      id, username, email, display_name, password_hash, source_supplier_id, source_agent_id,
      source_project_id, source_build_id, center_project_id, channel_code, app_version,
      device_id, device_name, model_points_per_usd, organization_id, last_login_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
    [
      id,
      username,
      email,
      displayName,
      hashPassword(password),
      sourceSupplierId,
      sourceAgentId,
      sourceProjectId,
      sourceBuildId,
      centerProjectIdValue,
      channelCode,
      appVersion,
      deviceId,
      deviceName,
      defaultModelPointsPerUsd,
      sourceOrganization?.id || '',
    ],
  )
  await assignDefaultFreeMembership(id).catch((err) => writeAppLog('membership', `assign free membership failed for ${id}: ${err instanceof Error ? err.message : String(err)}`))
  const user = await findEndUserWithMembershipById(id)
  await appendEndUserEvent(id, 'user_registered', {
    sourceSupplierId,
    sourceAgentId,
    sourceProjectId,
    sourceBuildId,
    centerProjectId: centerProjectIdValue,
    channelCode,
    appVersion,
    deviceId,
  })
  const token = await createEndUserSession(user, input)
  return { user: sanitizeEndUser(user), token }
}

async function createEndUserByAdmin(input = {}, actor = {}) {
  const account = normalizeManualEndUserAccount(input)
  const sourceProjectId = String(input.sourceProjectId || '').trim()
  if (sourceProjectId) {
    const project = await findProjectById(sourceProjectId)
    if (!project || !canOperateProject(actor, project)) throw new Error('无权为该项目开通账号')
  }
  const actorId = String(actor?.id || '').trim()
  const ownerUserId = String(actor?.organizationContext?.legacyOwnerUserId || actorId).trim()
  const organizationId = String(actor?.organizationContext?.organizationId || '').trim()
  if (!ownerUserId || !organizationId) throw new Error('无法确定终端用户所属组织')
  if (await findEndUserByUsername(account.username)) throw new Error('该终端用户账号已存在')
  if (await findEndUserByEmail(account.email)) throw new Error('该邮箱已被终端用户使用')

  const id = crypto.randomUUID()
  const settings = await getPlatformSettings('platform')
  const defaultModelPointsPerUsd = Math.max(0, Number(settings.modelPointsPerUsd || defaultPlatformSettings.modelPointsPerUsd))
  try {
    await db().query(
      `INSERT INTO ai_end_users (
        id, username, email, display_name, password_hash, status, source_agent_id,
        model_points_per_usd, organization_id, source_project_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        account.username,
        account.email,
        account.displayName,
        hashPassword(account.password),
        account.status,
        ownerUserId,
        defaultModelPointsPerUsd,
        organizationId,
        sourceProjectId,
      ],
    )
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') throw new Error('终端用户账号或邮箱已存在')
    throw err
  }

  await assignDefaultFreeMembership(id).catch((err) => writeAppLog('membership', `assign free membership failed for manually created user ${id}: ${err instanceof Error ? err.message : String(err)}`))
  await appendEndUserEvent(id, 'user_created_by_admin', {
    actorId,
    actorUsername: String(actor?.username || ''),
    initialStatus: account.status,
  }).catch((err) => writeAppLog('end-user', `append creation event failed for ${id}: ${err instanceof Error ? err.message : String(err)}`))
  writeAppLog('end-user', `Created end user ${account.username} by ${actor?.username || actorId}`)
  const userWithMembership = await findEndUserWithMembershipById(id).catch((err) => {
    writeAppLog('membership', `load membership failed for manually created user ${id}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  })
  return sanitizeEndUser(userWithMembership || await findEndUserById(id))
}

async function assignDefaultFreeMembership(userId) {
  const id = String(userId || '').trim()
  if (!id) return null
  const resolvedOwnerId = await keyOwnerUserIdForEndUser(id)
  const owner = await findUserById(resolvedOwnerId)
  const ownerUserId = owner?.id || 'admin'
  const cardId = await ensureAccountFreeMembership(ownerUserId)
  const [cards] = await db().query('SELECT id, name, packages_json FROM ai_membership_cards WHERE id = ? AND created_by = ? AND status = "enabled" LIMIT 1', [cardId, ownerUserId])
  const card = cards[0]
  if (!card) return null
  const packages = parseJson(card.packages_json, [])
  const selected = packages[0] || { name: '永久免费', durationDays: 0, bonusPoints: 0, pointsDurationDays: 0 }
  return grantMembershipBenefits({
    userId: id,
    card: { id: card.id, name: card.name },
    membershipPackage: selected,
    source: 'register',
    createdBy: ownerUserId,
    keepExisting: true,
  })
}

async function loginEndUser(input = {}) {
  const user = await findEndUserByUsername(input.username)
  if (!user || !verifyPassword(String(input.password || ''), user.passwordHash)) {
    throw new Error('账号或密码不正确')
  }
  if (user.status !== 'enabled') throw new Error('账号已被停用，请联系管理员')
  if (input.sourceProjectId) await clientProjectPolicy.assertAccess(input.sourceProjectId, user)
  await db().query('UPDATE ai_end_users SET last_login_at = CURRENT_TIMESTAMP(3), device_id = ?, device_name = ?, app_version = ? WHERE id = ?', [
    normalizeSourceText(input.deviceId, 160),
    normalizeSourceText(input.deviceName, 160),
    normalizeSourceText(input.appVersion, 64),
    user.id,
  ])
  await appendEndUserEvent(user.id, 'user_login', {
    deviceId: normalizeSourceText(input.deviceId, 160),
    appVersion: normalizeSourceText(input.appVersion, 64),
  })
  const nextUser = await findEndUserWithMembershipById(user.id)
  const token = await createEndUserSession(nextUser, input)
  return { user: sanitizeEndUser(nextUser), token }
}

async function listEndUsersForAdmin(user, query = {}) {
  const ownerUserId = user.organizationContext?.legacyOwnerUserId || user.id
  const accessibleIds = (user.organizationContext?.accessibleOrganizationIds || [user.organizationContext?.organizationId]).filter((id) => id && id !== '*')
  let sql = `SELECT u.*,
    (SELECT COUNT(*) FROM ai_end_user_model_access a WHERE a.user_id = u.id) AS allowed_model_count,
    m.id AS membership_id,
    m.card_id AS membership_card_id,
    m.package_name AS membership_package_name,
    m.started_at AS membership_started_at,
    m.expires_at AS membership_expires_at,
    m.points_expires_at AS membership_points_expires_at,
    m.status AS membership_status,
    c.name AS membership_card_name,
    c.level AS membership_card_level,
    (SELECT COUNT(*) FROM ai_membership_card_model_access ma WHERE ma.card_id = m.card_id) AS membership_allowed_model_count,
    COALESCE(NULLIF(u.source_agent_id, ''), p.owner_user_id, 'admin') AS operation_owner_user_id
    FROM ai_end_users u
    LEFT JOIN ai_projects p ON p.id = u.source_project_id
    LEFT JOIN ai_end_user_memberships m
      ON m.id = (
        SELECT mm.id
        FROM ai_end_user_memberships mm
        WHERE mm.user_id = u.id
          AND mm.status = 'active'
          AND (mm.expires_at IS NULL OR mm.expires_at > CURRENT_TIMESTAMP(3))
        ORDER BY mm.created_at DESC
        LIMIT 1
      )
    LEFT JOIN ai_membership_cards c ON c.id = m.card_id`
  const params = []
  const where = []
  if (user.organizationContext?.dataScope !== 'platform') {
    where.push(`(u.organization_id IN (${accessibleIds.map(() => '?').join(',')}) OR (u.organization_id='' AND (u.source_agent_id = ? OR u.source_project_id IN (SELECT id FROM ai_projects WHERE owner_user_id = ?))))`)
    params.push(...accessibleIds, ownerUserId, ownerUserId)
  }
  const status = String(query.status || '').trim()
  const search = buildListSearch(query, {
    user: ['u.username', 'u.display_name', 'u.email'],
    userId: ['u.id'],
    source: ['u.organization_id', 'u.source_agent_id', 'u.source_project_id', 'u.center_project_id', 'u.channel_code', 'u.device_name'],
  })
  if (search.clause) { where.push(search.clause); params.push(...search.params) }
  if (status && status !== 'all') { where.push('u.status = ?'); params.push(status) }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  sql += whereSql
  const paged = isPaginationRequested(query)
  const pagination = parsePagination(query)
  let total = 0
  if (paged) { const [[countRow]] = await db().query(`SELECT COUNT(*) AS total FROM ai_end_users u${whereSql}`, params); total = Number(countRow?.total || 0) }
  sql += paged ? ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?' : ' ORDER BY u.created_at DESC LIMIT 500'
  const rowParams = paged ? [...params, pagination.pageSize, pagination.offset] : params
  let [rows] = await db().query(sql, rowParams)
  const missingMembershipRows = rows.filter((row) => !row.membership_id)
  if (missingMembershipRows.length > 0) {
    for (const row of missingMembershipRows) {
      await ensureEndUserMembershipFallback(row.id, row.operation_owner_user_id)
    }
    ;[rows] = await db().query(sql, rowParams)
  }
  const items = rows.map((row) => {
    row.can_operate = String(row.organization_id || '') === String(user.organizationContext?.organizationId || '')
      || String(row.operation_owner_user_id || '') === String(ownerUserId || '')
    return row
  }).map(normalizeEndUser).map(sanitizeEndUser)
  return paged ? pageResult(items, total, pagination) : items
}

async function canAccessEndUser(actor, endUser) {
  if (!actor || !endUser) return false
  if (actor.organizationContext?.dataScope === 'platform') return true
  if (endUser.organizationId && actor.organizationContext?.accessibleOrganizationIds?.includes(endUser.organizationId)) return true
  const ownerUserId = actor.organizationContext?.legacyOwnerUserId || actor.id
  if (endUser.sourceAgentId && endUser.sourceAgentId === ownerUserId) return true
  if (endUser.sourceProjectId) {
    const project = await findProjectById(endUser.sourceProjectId)
    return project?.ownerUserId === ownerUserId
  }
  return false
}

async function assertCanAccessEndUser(actor, endUserId) {
  const user = await findEndUserById(endUserId)
  if (!user) throw new Error('终端用户不存在')
  if (!await canAccessEndUser(actor, user)) {
    const err = new Error('无权访问该终端用户')
    err.statusCode = 403
    throw err
  }
  return user
}

async function canOperateEndUser(actor, endUser) {
  if (!actor || !endUser) return false
  const ownerUserId = await keyOwnerUserIdForEndUser(endUser.id)
  const actorOwnerUserId = actor.organizationContext?.legacyOwnerUserId || actor.id
  return String(ownerUserId || '') === String(actorOwnerUserId || '')
}

async function assertCanOperateEndUser(actor, endUserId) {
  const user = await findEndUserById(endUserId)
  if (!user) throw new Error('终端用户不存在')
  if (!await canOperateEndUser(actor, user)) {
    const err = new Error('无权操作非当前账号名下的终端用户')
    err.statusCode = 403
    throw err
  }
  return user
}

async function updateEndUserStatus(id, status) {
  const nextStatus = status === 'disabled' ? 'disabled' : 'enabled'
  await db().query('UPDATE ai_end_users SET status = ? WHERE id = ?', [nextStatus, String(id || '')])
  return sanitizeEndUser(await findEndUserById(id))
}

async function changeEndUserPassword(user, input = {}) {
  const oldPassword = String(input.oldPassword || '')
  const newPassword = String(input.newPassword || '')
  if (!verifyPassword(oldPassword, user.passwordHash)) throw new Error('原密码不正确')
  if (newPassword.length < 6) throw new Error('新密码至少 6 位')
  await db().query('UPDATE ai_end_users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), user.id])
  await appendEndUserEvent(user.id, 'password_changed', { deviceId: normalizeSourceText(input.deviceId, 160) })
  return { updated: true }
}

function smtpConfigured(settings = {}) {
  return Boolean(settings.smtpHost && settings.smtpPort && settings.smtpUser && settings.smtpPass && settings.smtpFromEmail)
}

function createPasswordResetCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function passwordResetCodeHash(email, code) {
  return hashSecretToken(`${normalizeEmail(email)}:${String(code || '').trim()}`)
}

function registrationCodeHash(email, username, code) {
  return hashSecretToken(`${normalizeEmail(email)}:${safeEndUsername(username)}:${String(code || '').trim()}`)
}

function clientRequestIp(input = {}, req = null) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  return normalizeSourceText(input.requestIp || forwarded || req?.socket?.remoteAddress || '', 64)
}

async function sendRegistrationCodeEmail(email, username, code, settings) {
  if (!smtpConfigured(settings)) throw new Error('邮件服务未配置，请联系管理员')
  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: Number(settings.smtpPort || 465),
    secure: Boolean(settings.smtpSecure),
    auth: { user: settings.smtpUser, pass: settings.smtpPass },
  })
  const fromName = String(settings.smtpFromName || defaultPlatformSettings.smtpFromName || 'Agent AI').trim()
  const fromEmail = normalizeEmail(settings.smtpFromEmail)
  await transporter.sendMail({
    from: fromName ? `"${fromName.replace(/"/g, '')}" <${fromEmail}>` : fromEmail,
    to: email,
    subject: 'Agent AI 注册验证码',
    text: `您的注册验证码是：${code}\n\n账号：${username}\n验证码 10 分钟内有效。如非本人操作，请忽略本邮件。`,
    html: `<p>您的注册验证码是：</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>账号：${username}</p><p>验证码 10 分钟内有效。如非本人操作，请忽略本邮件。</p>`,
  })
}

async function sendPasswordResetEmail(user, code, settings) {
  if (!smtpConfigured(settings)) throw new Error('邮件服务未配置，请联系管理员')
  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: Number(settings.smtpPort || 465),
    secure: Boolean(settings.smtpSecure),
    auth: { user: settings.smtpUser, pass: settings.smtpPass },
  })
  const fromName = String(settings.smtpFromName || defaultPlatformSettings.smtpFromName || 'Agent AI').trim()
  const fromEmail = normalizeEmail(settings.smtpFromEmail)
  await transporter.sendMail({
    from: fromName ? `"${fromName.replace(/"/g, '')}" <${fromEmail}>` : fromEmail,
    to: user.email,
    subject: 'Agent AI 密码重置验证码',
    text: `您的密码重置验证码是：${code}\n\n验证码 10 分钟内有效。如果不是您本人操作，请忽略本邮件。`,
    html: `<p>您的密码重置验证码是：</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>验证码 10 分钟内有效。如果不是您本人操作，请忽略本邮件。</p>`,
  })
}

async function sendSmtpTestEmail(input = {}, actor = null) {
  const to = normalizeEmail(input.email || input.to)
  const settings = await getPlatformSettings('platform')
  if (!smtpConfigured(settings)) throw new Error('邮件服务未配置完整，请先保存 SMTP 配置')
  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: Number(settings.smtpPort || 465),
    secure: Boolean(settings.smtpSecure),
    auth: { user: settings.smtpUser, pass: settings.smtpPass },
  })
  const fromName = String(settings.smtpFromName || defaultPlatformSettings.smtpFromName || 'Agent AI').trim()
  const fromEmail = normalizeEmail(settings.smtpFromEmail)
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  await transporter.sendMail({
    from: fromName ? `"${fromName.replace(/"/g, '')}" <${fromEmail}>` : fromEmail,
    to,
    subject: 'Agent AI 邮件服务测试',
    text: `这是一封 Agent AI 管理后台 SMTP 测试邮件。\n\n发送时间：${now}\n操作账号：${actor?.username || actor?.id || '-'}\n\n如果您收到这封邮件，说明邮件服务配置可用。`,
    html: `<p>这是一封 <strong>Agent AI 管理后台 SMTP 测试邮件</strong>。</p><p>发送时间：${now}</p><p>操作账号：${actor?.username || actor?.id || '-'}</p><p>如果您收到这封邮件，说明邮件服务配置可用。</p>`,
  })
  writeAppLog('smtp', `Sent SMTP test email to ${to} by ${actor?.username || actor?.id || 'unknown'}`)
  return { message: '测试邮件已发送，请检查收件邮箱。', email: to }
}

async function requestEndUserRegistrationCode(input = {}, req = null) {
  await clientProjectPolicy.assertRegistration(input)
  const username = safeEndUsername(input.username)
  const email = normalizeEmail(input.email)
  const deviceId = normalizeSourceText(input.deviceId, 160)
  const requestIp = clientRequestIp(input, req)
  const settings = await getPlatformSettings('platform')
  if (!smtpConfigured(settings)) throw new Error('邮件服务未配置，请联系管理员')

  const existing = await findEndUserByUsername(username)
  if (existing) throw new Error('该账号已注册，请直接登录')
  const existingEmail = await findEndUserByEmail(email)
  if (existingEmail) throw new Error('该邮箱已注册，请直接登录或找回密码')

  const [[emailRate]] = await db().query(
    `SELECT COUNT(*) AS count
     FROM ai_end_user_registration_codes
     WHERE email = ? AND created_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)`,
    [email],
  )
  if (Number(emailRate?.count || 0) >= 5) throw new Error('验证码请求过于频繁，请稍后再试')
  if (deviceId) {
    const [[deviceRate]] = await db().query(
      `SELECT COUNT(*) AS count
       FROM ai_end_user_registration_codes
       WHERE device_id = ? AND created_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)`,
      [deviceId],
    )
    if (Number(deviceRate?.count || 0) >= 10) throw new Error('当前设备请求过于频繁，请稍后再试')
  }
  if (requestIp) {
    const [[ipRate]] = await db().query(
      `SELECT COUNT(*) AS count
       FROM ai_end_user_registration_codes
       WHERE request_ip = ? AND created_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)`,
      [requestIp],
    )
    if (Number(ipRate?.count || 0) >= 20) throw new Error('当前网络请求过于频繁，请稍后再试')
  }

  await db().query(
    `UPDATE ai_end_user_registration_codes
     SET status = 'disabled'
     WHERE email = ? AND username = ? AND status = 'pending'`,
    [email, username],
  )
  const code = createPasswordResetCode()
  await db().query(
    `INSERT INTO ai_end_user_registration_codes
      (id, email, username, code_hash, source_supplier_id, source_agent_id, source_project_id, source_build_id, center_project_id, channel_code, app_version, device_id, device_name, request_ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 10 MINUTE))`,
    [
      crypto.randomUUID(),
      email,
      username,
      registrationCodeHash(email, username, code),
      normalizeSourceText(input.sourceSupplierId || input.supplierId, 80),
      normalizeSourceText(input.sourceAgentId || input.agentId, 80),
      normalizeSourceText(input.sourceProjectId || input.aiProjectId || input.projectId, 80),
      normalizeSourceText(input.sourceBuildId || input.buildId, 120),
      normalizeSourceText(input.centerProjectId, 80),
      normalizeSourceText(input.channelCode, 120),
      normalizeSourceText(input.appVersion, 64),
      deviceId,
      normalizeSourceText(input.deviceName, 160),
      requestIp,
    ],
  )
  await sendRegistrationCodeEmail(email, username, code, settings)
  writeAppLog('smtp', `Sent registration code email to ${email}`)
  return { message: '注册验证码已发送，请查收邮箱。' }
}

async function verifyEndUserRegistrationCode(input = {}) {
  const username = safeEndUsername(input.username)
  const email = normalizeEmail(input.email)
  const code = String(input.verificationCode || input.code || '').trim()
  if (!/^\d{6}$/.test(code)) throw new Error('验证码格式不正确')
  const [rows] = await db().query(
    `SELECT *
     FROM ai_end_user_registration_codes
     WHERE email = ? AND username = ? AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [email, username],
  )
  const registration = rows[0]
  if (!registration) throw new Error('验证码不存在或已失效')
  if (new Date(registration.expires_at).getTime() <= Date.now()) {
    await db().query('UPDATE ai_end_user_registration_codes SET status = "expired" WHERE id = ?', [registration.id])
    throw new Error('验证码已过期，请重新获取')
  }
  if (Number(registration.attempts || 0) >= Number(registration.max_attempts || 5)) {
    await db().query('UPDATE ai_end_user_registration_codes SET status = "disabled" WHERE id = ?', [registration.id])
    throw new Error('验证码尝试次数过多，请重新获取')
  }
  if (registration.code_hash !== registrationCodeHash(email, username, code)) {
    await db().query('UPDATE ai_end_user_registration_codes SET attempts = attempts + 1 WHERE id = ?', [registration.id])
    throw new Error('验证码不正确')
  }
  await db().query('UPDATE ai_end_user_registration_codes SET status = "used", used_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [registration.id])
  return { email, username }
}

async function requestEndUserPasswordReset(input = {}, req = null) {
  const email = normalizeEmail(input.email)
  const deviceId = normalizeSourceText(input.deviceId, 160)
  const requestIp = clientRequestIp(input, req)
  const settings = await getPlatformSettings('platform')
  const user = await findEndUserByEmail(email).catch(() => null)
  const generic = { message: '重置验证码已发送，请查收邮箱。' }
  if (!user) return generic
  if (user.status !== 'enabled') throw new Error('账号已被停用，请联系管理员')
  if (!smtpConfigured(settings)) throw new Error('邮件服务未配置，请联系管理员')

  const [[emailRate]] = await db().query(
    `SELECT COUNT(*) AS count
     FROM ai_end_user_password_reset_codes
     WHERE email = ? AND created_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)`,
    [email],
  )
  if (Number(emailRate?.count || 0) >= 5) throw new Error('验证码请求过于频繁，请稍后再试')
  if (deviceId) {
    const [[deviceRate]] = await db().query(
      `SELECT COUNT(*) AS count
       FROM ai_end_user_password_reset_codes
       WHERE device_id = ? AND created_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)`,
      [deviceId],
    )
    if (Number(deviceRate?.count || 0) >= 10) throw new Error('当前设备请求过于频繁，请稍后再试')
  }
  if (requestIp) {
    const [[ipRate]] = await db().query(
      `SELECT COUNT(*) AS count
       FROM ai_end_user_password_reset_codes
       WHERE request_ip = ? AND created_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)`,
      [requestIp],
    )
    if (Number(ipRate?.count || 0) >= 20) throw new Error('当前网络请求过于频繁，请稍后再试')
  }

  await db().query(
    `UPDATE ai_end_user_password_reset_codes
     SET status = 'disabled'
     WHERE user_id = ? AND status = 'pending'`,
    [user.id],
  )
  const code = createPasswordResetCode()
  await db().query(
    `INSERT INTO ai_end_user_password_reset_codes
      (id, user_id, email, code_hash, source_supplier_id, source_agent_id, source_project_id, source_build_id, center_project_id, channel_code, app_version, device_id, device_name, request_ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 10 MINUTE))`,
    [
      crypto.randomUUID(),
      user.id,
      email,
      passwordResetCodeHash(email, code),
      normalizeSourceText(input.sourceSupplierId || input.supplierId, 80),
      normalizeSourceText(input.sourceAgentId || input.agentId, 80),
      normalizeSourceText(input.sourceProjectId || input.aiProjectId || input.projectId, 80),
      normalizeSourceText(input.sourceBuildId || input.buildId, 120),
      normalizeSourceText(input.centerProjectId, 80),
      normalizeSourceText(input.channelCode, 120),
      normalizeSourceText(input.appVersion, 64),
      deviceId,
      normalizeSourceText(input.deviceName, 160),
      requestIp,
    ],
  )
  await sendPasswordResetEmail(user, code, settings)
  await appendEndUserEvent(user.id, 'password_reset_requested', { deviceId, requestIp })
  return generic
}

async function confirmEndUserPasswordReset(input = {}) {
  const email = normalizeEmail(input.email)
  const code = String(input.code || '').trim()
  const newPassword = String(input.newPassword || input.password || '')
  if (!/^\d{6}$/.test(code)) throw new Error('验证码格式不正确')
  if (newPassword.length < 6) throw new Error('新密码至少 6 位')
  const user = await findEndUserByEmail(email)
  if (!user) throw new Error('邮箱或验证码不正确')
  if (user.status !== 'enabled') throw new Error('账号已被停用，请联系管理员')
  const [rows] = await db().query(
    `SELECT *
     FROM ai_end_user_password_reset_codes
     WHERE user_id = ? AND email = ? AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [user.id, email],
  )
  const reset = rows[0]
  if (!reset) throw new Error('验证码不存在或已失效')
  if (new Date(reset.expires_at).getTime() <= Date.now()) {
    await db().query('UPDATE ai_end_user_password_reset_codes SET status = "expired" WHERE id = ?', [reset.id])
    throw new Error('验证码已过期，请重新获取')
  }
  if (Number(reset.attempts || 0) >= Number(reset.max_attempts || 5)) {
    await db().query('UPDATE ai_end_user_password_reset_codes SET status = "disabled" WHERE id = ?', [reset.id])
    throw new Error('验证码尝试次数过多，请重新获取')
  }
  if (reset.code_hash !== passwordResetCodeHash(email, code)) {
    await db().query('UPDATE ai_end_user_password_reset_codes SET attempts = attempts + 1 WHERE id = ?', [reset.id])
    throw new Error('验证码不正确')
  }
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('UPDATE ai_end_users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), user.id])
    await conn.query('UPDATE ai_end_user_password_reset_codes SET status = "used", used_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [reset.id])
    await conn.query('DELETE FROM ai_end_user_sessions WHERE user_id = ?', [user.id])
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  await appendEndUserEvent(user.id, 'password_reset_by_email', { deviceId: normalizeSourceText(input.deviceId, 160) })
  return { message: '密码已重置，请使用新密码登录。' }
}

async function resetEndUserPassword(id, password) {
  const nextPassword = String(password || '')
  if (nextPassword.length < 6) throw new Error('新密码至少 6 位')
  const user = await findEndUserById(id)
  if (!user) throw new Error('终端用户不存在')
  await db().query('UPDATE ai_end_users SET password_hash = ? WHERE id = ?', [hashPassword(nextPassword), user.id])
  await appendEndUserEvent(user.id, 'password_reset_by_admin', {})
  return sanitizeEndUser(await findEndUserById(id))
}

async function getEndUserModelAccess(id, scope = null) {
  const user = await findEndUserById(id)
  if (!user) throw new Error('终端用户不存在')
  const orgFilter = modelServiceScopeWhere(scope, 'm')
  const [modelRows] = await db().query(
    `SELECT m.*, p.name AS provider_name, p.status AS provider_status
     FROM ai_provider_models m
     JOIN ai_model_providers p ON p.id = m.provider_id
     WHERE m.archived_at IS NULL${orgFilter.clause ? ` AND ${orgFilter.clause}` : ''}
     ORDER BY p.sort_order ASC, m.sort_order ASC, m.created_at ASC`,
    orgFilter.params,
  )
  const [accessRows] = await db().query(
    'SELECT provider_model_id FROM ai_end_user_model_access WHERE user_id = ? ORDER BY created_at ASC',
    [user.id],
  )
  const models = modelRows.map((row) => ({
    ...normalizeProviderModel(row),
    providerStatus: row.provider_status || 'enabled',
  }))
  return {
    user: sanitizeEndUser(user),
    models,
    allowedModelIds: accessRows.map((row) => row.provider_model_id).filter(Boolean),
  }
}

async function saveEndUserModelAccess(id, input = {}, actor = null, scope = null) {
  const user = await findEndUserById(id)
  if (!user) throw new Error('终端用户不存在')
  const ids = Array.from(new Set((Array.isArray(input.modelIds) ? input.modelIds : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))).slice(0, 500)
  if (ids.length) {
    const orgFilter = modelServiceScopeWhere(scope, 'm')
    const [rows] = await db().query(
      `SELECT m.id FROM ai_provider_models m WHERE m.archived_at IS NULL AND m.id IN (?)${orgFilter.clause ? ` AND ${orgFilter.clause}` : ''}`,
      orgFilter.params.length ? [ids, ...orgFilter.params] : [ids],
    )
    const exists = new Set(rows.map((row) => row.id))
    const missing = ids.filter((item) => !exists.has(item))
    if (missing.length) throw new Error(`模型不存在或不在当前组织模型服务范围内：${missing.slice(0, 3).join(', ')}`)
  }
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('DELETE FROM ai_end_user_model_access WHERE user_id = ?', [user.id])
    for (const providerModelId of ids) {
      await conn.query(
        'INSERT INTO ai_end_user_model_access (user_id, provider_model_id) VALUES (?, ?)',
        [user.id, providerModelId],
      )
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  await appendEndUserEvent(user.id, 'model_access_updated', { modelIds: ids, adminId: actor?.id || '' }).catch(() => {})
  return getEndUserModelAccess(user.id, scope)
}

async function allowedProviderModelIdSetForUser(userId) {
  const id = String(userId || '').trim()
  if (!id) return null
  await ensureEndUserMembershipFallback(id)
  const [rows] = await db().query('SELECT provider_model_id FROM ai_end_user_model_access WHERE user_id = ?', [id])
  if (rows.length) return new Set(rows.map((row) => row.provider_model_id).filter(Boolean))
  const [membershipRows] = await db().query(
    `SELECT a.provider_model_id
     FROM ai_end_user_memberships m
     JOIN ai_membership_cards c ON c.id = m.card_id AND c.status = 'enabled'
     JOIN ai_membership_card_model_access a ON a.card_id = c.id
     WHERE m.user_id = ?
       AND m.status = 'active'
       AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP(3))
     ORDER BY m.created_at DESC, a.created_at ASC`,
    [id],
  )
  if (!membershipRows.length) return null
  return new Set(membershipRows.map((row) => row.provider_model_id).filter(Boolean))
}

async function appendCreditLedger(conn, userId, input = {}) {
  const [[row]] = await conn.query('SELECT credit_balance FROM ai_end_users WHERE id = ? LIMIT 1', [userId])
  const balanceAfter = Number(row?.credit_balance || 0)
  await conn.query(
    `INSERT INTO ai_credit_ledger (
      id, user_id, change_type, points_delta, balance_after, cost_usd, upstream_log_id, upstream_quota,
      provider_id, provider_name, provider_key_id, provider_key_preview, pricing_rule_id, billing_type, deduct_status,
      model_name, prompt_tokens, completion_tokens, total_tokens, note, request_id, raw_usage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      userId,
      String(input.changeType || 'adjust').slice(0, 32),
      Number(input.pointsDelta || 0),
      balanceAfter,
      Number(input.costUsd || 0),
      String(input.upstreamLogId || '').slice(0, 80),
      Math.max(0, Math.floor(Number(input.upstreamQuota || 0))),
      String(input.providerId || '').slice(0, 64),
      String(input.providerName || '').slice(0, 120),
      String(input.providerKeyId || '').slice(0, 64),
      String(input.providerKeyPreview || '').slice(0, 32),
      String(input.pricingRuleId || '').slice(0, 64),
      String(input.billingType || '').slice(0, 32),
      String(input.deductStatus || 'succeeded').slice(0, 32),
      String(input.modelName || '').slice(0, 120),
      Math.max(0, Math.floor(Number(input.promptTokens || 0))),
      Math.max(0, Math.floor(Number(input.completionTokens || 0))),
      Math.max(0, Math.floor(Number(input.totalTokens || 0))),
      String(input.note || '').slice(0, 255),
      String(input.requestId || '').slice(0, 80),
      input.rawUsage ? JSON.stringify(input.rawUsage) : null,
    ],
  )
  return balanceAfter
}

async function adjustEndUserCredits(id, input = {}, actor = null) {
  const amount = parseCreditAmount(input.amount, '调整积分')
  if (amount === 0) throw new Error('调整积分不能为 0')
  const user = await findEndUserById(id)
  if (!user) throw new Error('终端用户不存在')
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('SELECT credit_balance FROM ai_end_users WHERE id = ? FOR UPDATE', [user.id])
    await conn.query('UPDATE ai_end_users SET credit_balance = credit_balance + ? WHERE id = ?', [amount, user.id])
    await appendCreditLedger(conn, user.id, {
      changeType: 'admin_adjust',
      pointsDelta: amount,
      note: input.note || (amount > 0 ? '后台充值' : '后台扣减'),
      requestId: actor?.id || '',
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  await appendEndUserEvent(user.id, 'credits_adjusted', { amount, adminId: actor?.id || '', note: input.note || '' }).catch(() => {})
  return sanitizeEndUser(await findEndUserById(user.id))
}

function normalizeCreditLedgerRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    ownerUserId: row.owner_user_id || '',
    changeType: row.change_type,
    pointsDelta: Number(row.points_delta || 0),
    balanceAfter: Number(row.balance_after || 0),
    costUsd: Number(row.cost_usd || 0),
    upstreamLogId: row.upstream_log_id || '',
    upstreamQuota: Number(row.upstream_quota || 0),
    providerId: row.provider_id || '',
    providerName: row.provider_name || '',
    providerKeyId: row.provider_key_id || '',
    providerKeyPreview: row.provider_key_preview || '',
    pricingRuleId: row.pricing_rule_id || '',
    billingType: row.billing_type || '',
    deductStatus: row.deduct_status || '',
    modelName: row.model_name || '',
    promptTokens: Number(row.prompt_tokens || 0),
    completionTokens: Number(row.completion_tokens || 0),
    totalTokens: Number(row.total_tokens || 0),
    note: row.note || '',
    requestId: row.request_id || '',
    createdAt: row.created_at,
  }
}

async function listCreditLedgerPage(options = {}) {
  const userId = String(options.userId || '').trim()
  const ownerUserId = String(options.ownerUserId || '').trim()
  const changeType = String(options.changeType || '').trim()
  const actor = options.actor || null
  const pageSize = Math.max(1, Math.min(100, Number(options.pageSize || options.limit || 20)))
  const page = Math.max(1, Number(options.page || 1))
  const offset = (page - 1) * pageSize
  const ownerExpression = "COALESCE(NULLIF(u.source_agent_id, ''), p.owner_user_id, 'admin')"
  const context = options.organizationContext || actor?.organizationContext || null
  const accessibleIds = context?.dataScope === 'platform'
    ? []
    : [...new Set([...(context?.accessibleOrganizationIds || []), context?.organizationId].filter((id) => id && id !== '*'))]
  const accessWhere = []
  const accessParams = []
  if (accessibleIds.length) {
    accessWhere.push(`(u.organization_id IN (${accessibleIds.map(() => '?').join(',')}) OR (u.organization_id='' AND ${ownerExpression} = ?))`)
    accessParams.push(...accessibleIds, ownerUserId || actor?.id || 'admin')
  } else if (ownerUserId) {
    accessWhere.push(`${ownerExpression} = ?`)
    accessParams.push(ownerUserId)
  }
  const where = [...accessWhere]
  const params = [...accessParams]
  if (userId) {
    where.push('l.user_id = ?')
    params.push(userId)
  }
  if (changeType) {
    where.push('l.change_type = ?')
    params.push(changeType)
  }
  const search = buildListSearch(options, {
    ledgerId: ['l.id'],
    user: ['u.username', 'u.display_name'],
    userId: ['l.user_id'],
    note: ['l.note', 'l.request_id'],
  })
  if (search.clause) {
    where.push(search.clause)
    params.push(...search.params)
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  const accessWhereSql = accessWhere.length ? ` WHERE ${accessWhere.join(' AND ')}` : ''
  const ledgerJoins = `JOIN ai_end_users u ON u.id = l.user_id
     LEFT JOIN ai_projects p ON p.id = u.source_project_id`
  const [[countRow]] = await db().query(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN l.change_type = 'consume' AND l.deduct_status='succeeded' THEN ABS(l.points_delta) ELSE 0 END), 0) AS filtered_consumed
     FROM ai_credit_ledger l
     ${ledgerJoins}${whereSql}`,
    params,
  )
  const [[scopeRow]] = await db().query(
    `SELECT COALESCE(SUM(CASE WHEN l.change_type = 'consume' AND l.deduct_status='succeeded' THEN ABS(l.points_delta) ELSE 0 END), 0) AS total_consumed
     FROM ai_credit_ledger l
     ${ledgerJoins}${accessWhereSql}`,
    accessParams,
  )
  const total = Number(countRow?.total || 0)
  const [rows] = await db().query(
    `SELECT l.*, u.username, u.display_name, ${ownerExpression} AS owner_user_id
     FROM ai_credit_ledger l
     ${ledgerJoins}${whereSql}
     ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  )
  return {
    items: rows.map(normalizeCreditLedgerRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    filteredConsumed: Number(countRow?.filtered_consumed || 0),
    totalConsumed: Number(scopeRow?.total_consumed || 0),
  }
}

async function listCreditLedger(userId = '', limit = 200, actor = null) {
  return (await listCreditLedgerPage({ userId, page: 1, pageSize: limit, actor })).items
}

function usageCostUsd(usage = {}) {
  const promptTokens = Math.max(0, Number(usage.prompt_tokens || usage.input_tokens || 0))
  const completionTokens = Math.max(0, Number(usage.completion_tokens || usage.output_tokens || 0))
  const totalTokens = Math.max(0, Number(usage.total_tokens || promptTokens + completionTokens))
  const costUsd = (promptTokens / 1_000_000) * 0.3 + (completionTokens / 1_000_000) * 1.0
  return { promptTokens, completionTokens, totalTokens, costUsd: Math.round(costUsd * 100_000_000) / 100_000_000 }
}

function parseProviderLogOther(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return {}
  }
}

function normalizeProviderUsageLog(row = {}) {
  const other = parseProviderLogOther(row.other)
  const promptTokens = Math.max(0, Math.floor(Number(row.prompt_tokens || row.prompt || row.prompt_tokens_used || 0)))
  const completionTokens = Math.max(0, Math.floor(Number(row.completion_tokens || row.completion || row.completion_tokens_used || 0)))
  const totalTokens = Math.max(0, Math.floor(Number(row.total_tokens || row.total || promptTokens + completionTokens || 0)))
  const quota = Math.max(0, Math.floor(Number(row.quota || 0)))
  return {
    id: String(row.id || ''),
    createdAt: Number(row.created_at || 0),
    type: Number(row.type || 0),
    modelName: String(row.model_name || ''),
    quota,
    costUsd: Math.round((quota / 500000) * 100000000) / 100000000,
    promptTokens,
    completionTokens,
    totalTokens,
    requestId: String(other.request_id || row.request_id || ''),
    raw: row,
  }
}

async function fetchProviderUsageLogs(settings, options = {}) {
  const usageBaseUrl = normalizeHttpUrl(settings.modelUsageBaseUrl || defaultPlatformSettings.modelUsageBaseUrl)
  const apiKey = String(options.apiKey || settings.modelGatewayKey || '').trim()
  if (!usageBaseUrl || !apiKey) return { total: 0, items: [] }
  const now = Math.floor(Date.now() / 1000)
  const startTimestamp = Math.max(0, Number(options.startTimestamp || now - 3600))
  const endTimestamp = Math.max(startTimestamp, Number(options.endTimestamp || now + 60))
  const url = new URL(`${usageBaseUrl.replace(/\/$/, '')}/api/log/token`)
  url.searchParams.set('key', apiKey)
  url.searchParams.set('page', String(options.page || 1))
  url.searchParams.set('page_size', String(options.pageSize || 20))
  url.searchParams.set('start_timestamp', String(Math.floor(startTimestamp)))
  url.searchParams.set('end_timestamp', String(Math.floor(endTimestamp)))
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`查询模型用量失败：HTTP ${response.status}`)
  const payload = await response.json().catch(() => ({}))
  if (payload?.success === false) throw new Error(payload.message || payload.error || '查询模型用量失败')
  const data = payload.data || payload
  const rows = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : (Array.isArray(payload.items) ? payload.items : []))
  return {
    total: Number(data.total || payload.total || rows.length || 0),
    items: rows.map(normalizeProviderUsageLog).filter((item) => item.id && item.quota > 0),
  }
}

function normalizeTokenExpire(value) {
  const raw = numberOrNull(value)
  if (!raw || raw <= 0) return ''
  const milliseconds = raw > 10_000_000_000 ? raw : raw * 1000
  return new Date(milliseconds).toISOString()
}

function normalizeProviderTokenInfo(payload = {}, apiKey = '') {
  const row = pickFirstObject(payload) || {}
  const remainingQuota = numberOrNull(row.remain_quota ?? row.remaining_quota ?? row.remainQuota ?? row.remainingQuota ?? row.quota_remaining ?? row.quotaRemaining)
  const usedQuota = numberOrNull(row.used_quota ?? row.usedQuota ?? row.quota_used ?? row.quotaUsed ?? row.total_usage)
  const totalQuota = numberOrNull(row.quota ?? row.total_quota ?? row.totalQuota ?? row.quota_total ?? row.quotaTotal ?? row.hard_limit_usd ?? row.system_hard_limit_usd ?? row.soft_limit_usd)
  const total = totalQuota ?? (remainingQuota != null && usedQuota != null ? remainingQuota + usedQuota : null)
  const expiresAt = normalizeTokenExpire(row.expired_time ?? row.expire_time ?? row.expires_at ?? row.expiresAt ?? row.access_until)
  return {
    name: String(row.name || row.token_name || row.tokenName || row.remark || row.title || ''),
    keyPreview: previewSecret(apiKey),
    totalQuota: total,
    remainingQuota: remainingQuota ?? (total != null && usedQuota != null ? Math.max(0, total - usedQuota) : null),
    usedQuota,
    unlimited: Boolean(row.unlimited_quota || row.unlimitedQuota),
    expiresAt,
    expiresNever: Number(row.access_until || 0) === 0,
  }
}

async function fetchProviderTokenInfo(settings, apiKey = '') {
  const usageBaseUrl = normalizeHttpUrl(settings.modelUsageBaseUrl || defaultPlatformSettings.modelUsageBaseUrl)
  const key = String(apiKey || '').trim()
  if (!usageBaseUrl || !key) return null
  const base = usageBaseUrl.replace(/\/$/, '')
  try {
    const subscriptionUrl = `${base}/v1/dashboard/billing/subscription`
    const subscriptionResponse = await fetch(subscriptionUrl, { headers: { accept: 'application/json', authorization: `Bearer ${key}` } })
    if (subscriptionResponse.ok) {
      const subscription = await subscriptionResponse.json().catch(() => ({}))
      const today = localDateString()
      const usageUrl = `${base}/v1/dashboard/billing/usage?start_date=${encodeURIComponent(today)}&end_date=${encodeURIComponent(today)}`
      const usageResponse = await fetch(usageUrl, { headers: { accept: 'application/json', authorization: `Bearer ${key}` } })
      const usage = usageResponse.ok ? await usageResponse.json().catch(() => ({})) : {}
      const usedQuota = numberOrNull(usage.total_usage) != null ? Math.round((Number(usage.total_usage) / 100) * 1_000_000) / 1_000_000 : null
      return normalizeProviderTokenInfo({ ...subscription, used_quota: usedQuota }, key)
    }
  } catch {
    // Fall back to provider-specific token endpoints below.
  }
  const paths = ['/api/token/self', '/api/token/info', '/api/user/token']
  for (const pathName of paths) {
    try {
      const url = new URL(`${base}${pathName}`)
      url.searchParams.set('key', key)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal }).finally(() => clearTimeout(timer))
      if (!response.ok) continue
      const payload = await response.json().catch(() => ({}))
      if (payload?.success === false) continue
      return normalizeProviderTokenInfo(payload, key)
    } catch {
      // Some providers expose only usage logs. Keep this endpoint best-effort.
    }
  }
  return normalizeProviderTokenInfo({}, key)
}

async function latestProviderUsageLog(settings, apiKey = '') {
  const now = Math.floor(Date.now() / 1000)
  const result = await fetchProviderUsageLogs(settings, { apiKey, startTimestamp: now - 86400, endTimestamp: now + 60, pageSize: 1 })
  return result.items[0] || null
}

async function findNewProviderUsageLog(settings, apiKey, beforeLogId, startedAtSeconds, modelName = '') {
  const started = Math.max(0, Math.floor(Number(startedAtSeconds || 0)) - 10)
  const beforeId = Number(beforeLogId || 0)
  const targetModel = String(modelName || '').trim()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await fetchProviderUsageLogs(settings, {
      apiKey,
      startTimestamp: started,
      endTimestamp: Math.floor(Date.now() / 1000) + 120,
      pageSize: 20,
    })
    const candidates = result.items
      .filter((item) => Number(item.id) > beforeId)
      .filter((item) => !targetModel || item.modelName === targetModel)
      .sort((a, b) => Number(a.id) - Number(b.id))
    if (candidates[0]) return candidates[0]
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}

function getEndUserModelGatewayKey(user, settings = {}) {
  return String(user?.modelGatewayKey || '').trim()
}

async function setEndUserModelGatewayKey(id, input = {}, actor = null) {
  const user = await findEndUserById(id)
  if (!user) throw new Error('终端用户不存在')
  const key = String(input.modelGatewayKey || input.key || '').trim()
  if (!key) throw new Error('请输入模型服务 Key')
  if (!/^sk-[A-Za-z0-9]{20,}$/.test(key)) throw new Error('模型服务 Key 格式不正确')
  await db().query('UPDATE ai_end_users SET model_gateway_key = ? WHERE id = ?', [key, user.id])
  await appendEndUserEvent(user.id, 'model_key_updated', { adminId: actor?.id || '' }).catch(() => {})
  return sanitizeEndUser(await findEndUserById(user.id))
}

function parseModelPointsPerUsd(input, fallback = defaultPlatformSettings.modelPointsPerUsd) {
  const raw = String(input ?? '').trim()
  const value = raw === '' ? Number(fallback || defaultPlatformSettings.modelPointsPerUsd) : Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error('积分折算比例必须大于 0')
  return Math.round(value * 1_000_000) / 1_000_000
}

async function setEndUserModelPointsPerUsd(id, input = {}, actor = null) {
  const user = await findEndUserById(id)
  if (!user) throw new Error('终端用户不存在')
  const settings = await getPlatformSettings('platform')
  const points = parseModelPointsPerUsd(input.modelPointsPerUsd ?? input.pointsPerUsd, settings.modelPointsPerUsd)
  await db().query('UPDATE ai_end_users SET model_points_per_usd = ? WHERE id = ?', [points, user.id])
  await appendEndUserEvent(user.id, 'model_points_per_usd_updated', { adminId: actor?.id || '', modelPointsPerUsd: points }).catch(() => {})
  return sanitizeEndUser(await findEndUserById(user.id))
}

function modelPointsPerUsdForUser(user, settings) {
  const userPoints = Number(user?.modelPointsPerUsd || 0)
  if (Number.isFinite(userPoints) && userPoints > 0) return userPoints
  const settingPoints = Number(settings?.modelPointsPerUsd || 0)
  if (Number.isFinite(settingPoints) && settingPoints > 0) return settingPoints
  return defaultPlatformSettings.modelPointsPerUsd
}

function normalizeUsageTokens(usage = {}) {
  return normalizeTokenUsage(usage)
}

function calculateLocalBillingPoints(rule, usage = {}) {
  const billingType = rule?.billingType || 'per_token'
  if (billingType === IMAGE_BILLING_TYPE) {
    return calculateImageBillingPoints(rule, usage)
  }
  if (billingType === 'per_request') {
    const points = Math.max(0, Number(rule.pointsPerRequest || 0))
    return { ...normalizeUsageTokens(usage), points: Math.round(points * 1_000_000) / 1_000_000 }
  }
  const tokens = normalizeUsageTokens(usage)
  const inputPrice = Math.max(0, Number(rule?.inputPointsPerMTokens || 0))
  const outputPrice = Math.max(0, Number(rule?.outputPointsPerMTokens || 0))
  const points = (tokens.promptTokens / 1_000_000) * inputPrice + (tokens.completionTokens / 1_000_000) * outputPrice
  return { ...tokens, points: Math.round(points * 1_000_000) / 1_000_000 }
}

async function materializeModelProviderKey(row) {
  if (!row) return null
  const apiKey = row.secret_ciphertext
    ? await voiceCredentialVault.unseal(row.secret_ciphertext, row.upstream_account_id)
    : String(row.api_key || '')
  return { ...row, api_key: apiKey }
}

function calculateCompoundBillingPoints(rule, usage = {}, plan = null, rates = { CNY: 1 }) {
  const legacy = calculateLocalBillingPoints(rule, usage)
  const effectivePlan = plan || legacyRulePricingPlan(rule, rule?.billingType === IMAGE_BILLING_TYPE ? 'image_generation' : 'chat')
  const events = []
  if (effectivePlan.taskType === 'image_generation' || effectivePlan.taskType === 'image_edit') {
    events.push(...imageUsageEvents(usage))
  } else {
    const tokens = tokenUsageEvents(effectivePlan, usage)
    events.push(usageEvent('request', 1, { phase: 'request' }))
    events.push(...tokens.events)
  }
  const quote = quotePricing(effectivePlan, events, { CNY: 1, ...rates })
  return { ...legacy, points: quote.points, compoundQuote: quote }
}

async function keyOwnerUserIdForEndUser(userId = '') {
  const user = await findEndUserById(userId)
  if (!user) return 'admin'
  if (user.sourceAgentId) return user.sourceAgentId
  if (user.sourceProjectId) {
    const project = await findProjectById(user.sourceProjectId)
    if (project?.ownerUserId) return project.ownerUserId
  }
  return 'admin'
}

async function resolveModelProxyContext(requestedModel = '', userId = '', requiredModelType = '') {
  const targetModel = String(requestedModel || '').trim()
  const targetModelType = requiredModelType ? normalizeProviderModelType(requiredModelType) : ''
  const keyOwnerUserId = await keyOwnerUserIdForEndUser(userId)
  const allowedModelIds = await allowedProviderModelIdSetForUser(userId)
  const endUser = await findEndUserById(userId)
  const endUserOrganizationId = String(endUser?.organizationId || '')
  const params = []
  let where = "WHERE m.archived_at IS NULL AND m.status = 'enabled' AND p.status = 'enabled'"
  if (endUserOrganizationId) {
    where += ' AND m.organization_id = ?'
    params.push(endUserOrganizationId)
  }
  if (targetModelType) {
    where += ' AND m.model_type = ?'
    params.push(targetModelType)
  }
  params.push(targetModel)
  const [modelRows] = await db().query(
    `SELECT m.*, p.name AS provider_name, p.base_url, p.protocol, p.timeout_ms, p.status AS provider_status, p.is_default AS provider_is_default, p.sort_order AS provider_sort_order
     FROM ai_provider_models m
     JOIN ai_model_providers p ON p.id = m.provider_id
     ${where}
     ORDER BY
      CASE WHEN m.model_id = ? THEN 0 ELSE 1 END,
      CASE WHEN p.is_default = 1 THEN 0 ELSE 1 END,
      CASE WHEN m.is_default = 1 THEN 0 ELSE 1 END,
      p.sort_order ASC,
      m.sort_order ASC,
      m.created_at ASC`,
    params,
  )
  const isAllowedModel = (item) => !allowedModelIds || allowedModelIds.has(item.id)
  const row = targetModel
    ? modelRows.find((item) => item.model_id === targetModel && isAllowedModel(item))
    : modelRows.find(isAllowedModel)
  if (!row) {
    if (allowedModelIds) throw new Error(targetModel ? `当前账号无权使用模型 ${targetModel}` : '当前账号暂无可用授权模型')
    if (targetModel) throw new Error(`模型 ${targetModel} 未启用或未配置${targetModelType ? `为 ${targetModelType} 分类` : ''}`)
    throw new Error(targetModelType ? `暂无可用${targetModelType === 'search' ? '搜索' : targetModelType}模型，请先在后台配置服务商和模型` : '暂无可用模型，请先在后台配置服务商和模型')
  }
  const provider = normalizeModelProvider({
    id: row.provider_id,
    name: row.provider_name,
    protocol: row.protocol,
    base_url: row.base_url,
    status: row.provider_status,
    is_default: row.provider_is_default,
    timeout_ms: row.timeout_ms,
    sort_order: row.provider_sort_order,
  })
  const model = normalizeProviderModel(row)
  const keyRows = await selectEligibleModelKeys(db(), { ownerUserId: keyOwnerUserId, providerId: provider.id, providerModelId: model.id })
  const key = await materializeModelProviderKey(keyRows[0])
  if (!key?.api_key) throw new Error(`服务商 ${provider.name} 在当前账号下暂无适用于该模型的可用 Key，请检查 Key 池的适用模型配置`)
  const rules = await listModelPricingRules(provider.id)
  const legacyPricingRule = rules.find((item) => item.providerModelId === model.id && item.status === 'enabled')
  const taskType = model.modelType === 'image' ? 'image_generation' : model.modelType === 'search' ? 'web_search' : 'chat'
  const [[capability]] = await db().query("SELECT id FROM ai_model_task_capabilities WHERE provider_model_id=? AND task_type=? AND status='enabled' LIMIT 1", [model.id, taskType])
  const [pricingPlan, rateRows] = capability ? await Promise.all([
    pricingPlanRepository.findActiveByCapability(capability.id, model.organizationId || ''),
    pricingPlanRepository.rates(model.organizationId || ''),
  ]) : [null, []]
  const pricingRule = effectiveGatewayPricingRule(legacyPricingRule, pricingPlan)
  if (!pricingRule) throw new Error(`模型 ${model.modelId} 未配置启用中的计费方案`)
  await db().query('UPDATE ai_model_provider_keys SET last_used_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [key.id])
  const endpointPath = normalizeModelEndpointPath(model.endpointPath, model.modelType)
  return {
    provider,
    model,
    key: { id: key.id, apiKey: String(key.api_key || ''), keyPreview: key.key_preview || previewSecret(key.api_key) },
    pricingRule,
    pricingPlan,
    pricingRates: Object.fromEntries(rateRows.map(item => [item.currency, item.cnyRate])),
    endpointPath,
  }
}

async function generateImageForClient(userId, input = {}, resolvedContext = null) {
  const request = normalizeImageGenerationRequest(input)
  const context = resolvedContext || await resolveModelProxyContext(request.model, userId, 'image')
  if (context.model.modelType !== 'image') throw new Error('当前模型分类不是图片模型，请选择图片生成模型')
  const upstreamBody = buildUpstreamImagePayload(request, context.model.modelId)
  const endpointPath = context.endpointPath || '/images/generations'
  const upstreamUrl = `${String(context.provider.baseUrl || '').replace(/\/$/, '')}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`
  const providerTimeoutMs = Math.max(10000, Number(context.provider.timeoutMs || 300000))
  const proxyStartedAt = Date.now()
  const proxyLogContext = {
    requestId: String(input?.requestId || crypto.randomUUID()),
    userId,
    providerId: context.provider.id,
    providerName: context.provider.name,
    modelId: context.model.modelId,
  }
  writeAppLog('image-proxy', JSON.stringify({
    event: 'request',
    ...proxyLogContext,
    timeoutMs: providerTimeoutMs,
    size: upstreamBody.size,
    referenceCount: upstreamBody.image?.length || 0,
  }))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), providerTimeoutMs)
  let upstream
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.key.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify(upstreamBody),
    })
  } finally {
    clearTimeout(timer)
  }
  const text = await upstream.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    // Keep provider passthrough error message below.
  }
  if (!upstream.ok) {
    await recordModelKeyFailure(context.key.id, text)
    writeAppLog('image-proxy', JSON.stringify({
      event: 'failed',
      ...proxyLogContext,
      status: upstream.status,
      durationMs: Date.now() - proxyStartedAt,
      error: payload?.error?.message || text?.slice(0, 500) || upstream.statusText,
    }))
    throw Object.assign(new Error(payload?.error?.message || text?.slice(0, 500) || `图片生成服务返回 ${upstream.status}`), { statusCode: 502 })
  }
  const data = normalizeImageGenerationResponse(payload || {}, context, request)
  const billing = calculateCompoundBillingPoints(context.pricingRule, data.usage, context.pricingPlan, context.pricingRates)
  const tierSummary = Object.entries(billing.tierCounts || {})
    .map(([tier, count]) => `${tier}x${count}`)
    .join('、')
  await deductCreditsForLocalUsage(userId, context, data.usage, data.requestId, {
    note: tierSummary ? `图片生成扣费（${tierSummary}）` : '图片生成扣费',
  })
  await recordModelKeySuccess(context.key.id)
  writeAppLog('image-proxy', JSON.stringify({
    event: 'completed',
    ...proxyLogContext,
    status: upstream.status,
    durationMs: Date.now() - proxyStartedAt,
    generatedImages: data.usage.generated_images,
    points: billing.points,
  }))
  return {
    model: data.model,
    providerId: context.provider.id,
    providerName: context.provider.name,
    images: data.images,
    usage: data.usage,
    requestId: data.requestId,
    billing: {
      billingType: context.pricingRule.billingType,
      tierCounts: billing.tierCounts || {},
      generatedImages: billing.generatedImages,
      points: billing.points,
    },
  }
}

async function listClientModelCatalog(userId = '') {
  const keyOwnerUserId = await keyOwnerUserIdForEndUser(userId)
  const allowedModelIds = await allowedProviderModelIdSetForUser(userId)
  const endUser = await findEndUserById(userId)
  const endUserOrganizationId = String(endUser?.organizationId || '')
  const [rows] = await db().query(
    `SELECT m.*, p.name AS provider_name, p.is_default AS provider_is_default, p.sort_order AS provider_sort_order,
      EXISTS(SELECT 1 FROM ai_model_provider_keys k WHERE k.owner_user_id = ? AND k.provider_id = p.id AND k.status = 'enabled' AND (COALESCE(k.provider_model_id,'')='' OR k.provider_model_id=m.id)) AS has_enabled_key,
      r.id AS pricing_rule_id, r.billing_type AS pricing_billing_type,
      r.input_points_per_m_tokens AS pricing_input_points, r.output_points_per_m_tokens AS pricing_output_points,
      r.points_per_request AS pricing_request_points, r.resolution_points AS pricing_resolution_points,
      r.input_cost_points_per_m_tokens AS pricing_input_cost, r.output_cost_points_per_m_tokens AS pricing_output_cost,
      r.cost_points_per_request AS pricing_request_cost, r.resolution_cost_points AS pricing_resolution_cost,
      r.consumption_multiplier AS pricing_consumption_multiplier,
      c.id AS task_capability_id
     FROM ai_provider_models m
     JOIN ai_model_providers p ON p.id = m.provider_id
     LEFT JOIN ai_model_pricing_rules r ON r.provider_model_id = m.id AND r.status = 'enabled'
     LEFT JOIN ai_model_task_capabilities c ON c.provider_model_id=m.id AND c.status='enabled' AND c.task_type=(CASE
       WHEN m.model_type='image' THEN 'image_generation' WHEN m.model_type='search' THEN 'web_search'
       WHEN m.model_type='audio' THEN 'speech_synthesis' WHEN m.model_type='video' THEN 'video_generation' ELSE 'chat' END)
     WHERE m.archived_at IS NULL AND m.status = 'enabled' AND p.status = 'enabled'${endUserOrganizationId ? ' AND m.organization_id = ?' : ''}
     ORDER BY p.sort_order ASC, m.sort_order ASC, m.created_at ASC`,
    endUserOrganizationId ? [keyOwnerUserId, endUserOrganizationId] : [keyOwnerUserId],
  )
  const activePlans = endUserOrganizationId ? (await pricingPlanRepository.list({ organizationId: endUserOrganizationId })).filter(item => item.status === 'enabled') : []
  const plansByCapability = new Map(activePlans.map(item => [item.capabilityId, item]))
  const models = rows.filter((row) => !allowedModelIds || allowedModelIds.has(row.id)).map((row) => ({
    id: row.model_id || '',
    name: row.display_name || row.model_id || '',
    description: row.description || '',
    modelType: row.model_type || 'text',
    providerId: row.provider_id || '',
    providerName: row.provider_name || '',
    capabilities: parseJson(row.capabilities, []),
    reasoning: normalizeModelReasoning(parseJson(row.reasoning_config, {})),
    contextWindow: Number(row.context_window || 0),
    isDefault: Boolean(row.provider_is_default) && Boolean(row.is_default),
    configured: Boolean(row.has_enabled_key) && Boolean(row.pricing_rule_id || plansByCapability.has(row.task_capability_id)),
    pricing: plansByCapability.has(row.task_capability_id) ? legacyPricingProjection(plansByCapability.get(row.task_capability_id)) : row.pricing_rule_id ? clientPricingPayload(normalizeModelPricingRule({
      id: row.pricing_rule_id,
      billing_type: row.pricing_billing_type,
      input_points_per_m_tokens: row.pricing_input_points,
      output_points_per_m_tokens: row.pricing_output_points,
      points_per_request: row.pricing_request_points,
      resolution_points: row.pricing_resolution_points,
      input_cost_points_per_m_tokens: row.pricing_input_cost,
      output_cost_points_per_m_tokens: row.pricing_output_cost,
      cost_points_per_request: row.pricing_request_cost,
      resolution_cost_points: row.pricing_resolution_cost,
      consumption_multiplier: row.pricing_consumption_multiplier,
    })) : undefined,
  })).filter((item) => item.id)
  const chatModels = models.filter((item) => item.modelType === 'text')
  const defaultModel = chatModels.find((item) => item.isDefault && item.configured)
    || chatModels.find((item) => item.configured)
    || chatModels.find((item) => item.isDefault)
    || chatModels[0]
    || null
  return {
    models,
    searchModels: models.filter((item) => item.modelType === 'search'),
    defaultModelId: defaultModel?.id || '',
    configured: chatModels.some((item) => item.configured),
    searchConfigured: models.some((item) => item.modelType === 'search' && item.configured),
  }
}

async function recordModelKeyFailure(keyId, err) {
  if (!keyId) return
  await db().query(
    'UPDATE ai_model_provider_keys SET failure_count = failure_count + 1, last_error = ? WHERE id = ?',
    [String(err instanceof Error ? err.message : err || '').slice(0, 255), keyId],
  ).catch(() => {})
}

async function recordModelKeySuccess(keyId) {
  if (!keyId) return
  await db().query(
    'UPDATE ai_model_provider_keys SET success_count = success_count + 1 WHERE id = ?',
    [keyId],
  ).catch(() => {})
}

async function recordModelKeyUsageFailure(userId, context, requestId, errorMessage) {
  if (!userId || !context?.key?.id) return
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    await appendCreditLedger(conn, userId, {
      changeType: 'consume',
      pointsDelta: 0,
      providerId: context.provider.id,
      providerName: context.provider.name,
      providerKeyId: context.key.id,
      providerKeyPreview: context.key.keyPreview,
      pricingRuleId: context.pricingRule?.id || '',
      billingType: context.pricingRule?.billingType || '',
      deductStatus: 'failed',
      modelName: context.model?.modelId || '',
      note: String(errorMessage || '模型上游请求失败').slice(0, 255),
      requestId,
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

async function deductCreditsForLocalUsage(userId, context, usage, requestId = '', options = {}) {
  const billing = calculateCompoundBillingPoints(context.pricingRule, usage || {}, context.pricingPlan, context.pricingRates)
  const deductStatus = options.deductStatus || (billing.totalTokens > 0 || billing.generatedImages > 0 || context.pricingRule.billingType === 'per_request' ? 'succeeded' : 'missing_usage')
  const points = deductStatus === 'succeeded' && billing.points > 0 ? Math.max(0.000001, billing.points) : 0
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    await applyClientUsageDebit(conn, userId, {
      points,
      tokens: billing.totalTokens,
    })
    await appendCreditLedger(conn, userId, {
      changeType: 'consume',
      pointsDelta: -points,
      providerId: context.provider.id,
      providerName: context.provider.name,
      providerKeyId: context.key.id,
      providerKeyPreview: context.key.keyPreview,
      pricingRuleId: context.pricingRule.id,
      billingType: context.pricingRule.billingType,
      deductStatus,
      modelName: context.model.modelId,
      promptTokens: billing.promptTokens,
      completionTokens: billing.completionTokens,
      totalTokens: billing.totalTokens,
      note: options.note || (deductStatus === 'missing_usage' ? '模型调用成功，但上游未返回 usage，未扣费' : '模型调用扣费'),
      requestId,
      rawUsage: usage || {},
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  return sanitizeEndUser(await findEndUserById(userId))
}

async function deductCreditsForProviderLog(userId, usageLog, fallbackModelName = '') {
  if (!usageLog || Number(usageLog.quota || 0) <= 0) return sanitizeEndUser(await findEndUserById(userId))
  const settings = await getPlatformSettings('platform')
  const user = await findEndUserById(userId)
  const costUsd = Number(usageLog.costUsd || 0)
  const points = Math.max(0.000001, Math.round(costUsd * modelPointsPerUsdForUser(user, settings) * 1_000_000) / 1_000_000)
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    const [[exists]] = await conn.query('SELECT id FROM ai_credit_ledger WHERE upstream_log_id = ? LIMIT 1', [usageLog.id])
    if (exists) {
      await conn.commit()
      return sanitizeEndUser(await findEndUserById(userId))
    }
    await applyClientUsageDebit(conn, userId, {
      points,
      costUsd,
      tokens: usageLog.totalTokens,
    })
    await appendCreditLedger(conn, userId, {
      changeType: 'consume',
      pointsDelta: -points,
      costUsd,
      upstreamLogId: usageLog.id,
      upstreamQuota: usageLog.quota,
      modelName: usageLog.modelName || fallbackModelName,
      promptTokens: usageLog.promptTokens,
      completionTokens: usageLog.completionTokens,
      totalTokens: usageLog.totalTokens,
      note: '模型调用扣费',
      requestId: usageLog.requestId,
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  return sanitizeEndUser(await findEndUserById(userId))
}

async function deductCreditsForUsage(userId, usage, modelName, requestId) {
  const settings = await getPlatformSettings('platform')
  const user = await findEndUserById(userId)
  const { promptTokens, completionTokens, totalTokens, costUsd } = usageCostUsd(usage)
  if (totalTokens <= 0) return sanitizeEndUser(await findEndUserById(userId))
  const points = Math.max(0.000001, Math.round(costUsd * modelPointsPerUsdForUser(user, settings) * 1_000_000) / 1_000_000)
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    await applyClientUsageDebit(conn, userId, {
      points,
      costUsd,
      tokens: totalTokens,
    })
    await appendCreditLedger(conn, userId, {
      changeType: 'consume',
      pointsDelta: -points,
      costUsd,
      modelName,
      promptTokens,
      completionTokens,
      totalTokens,
      note: '模型调用扣费',
      requestId,
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  return sanitizeEndUser(await findEndUserById(userId))
}

async function getAgentUsage(userId) {
  const [[projectRow]] = await db().query('SELECT COUNT(*) AS count FROM ai_projects WHERE owner_user_id = ?', [userId])
  const [[buildRow]] = await db().query('SELECT COUNT(*) AS count FROM ai_builds WHERE owner_user_id = ?', [userId])
  return { projects: Number(projectRow?.count || 0), builds: Number(buildRow?.count || 0) }
}

async function deleteEndUsersByProject(conn, projectId) {
  const [users] = await conn.query('SELECT id FROM ai_end_users WHERE source_project_id = ?', [projectId])
  const ids = users.map((row) => row.id).filter(Boolean)
  if (ids.length === 0) return 0
  await conn.query('UPDATE ai_redeem_codes SET used_by_user_id = "" WHERE used_by_user_id IN (?)', [ids])
  await conn.query('DELETE FROM ai_end_user_model_access WHERE user_id IN (?)', [ids])
  await conn.query('DELETE FROM ai_end_user_sessions WHERE user_id IN (?)', [ids])
  await conn.query('DELETE FROM ai_end_user_events WHERE user_id IN (?)', [ids])
  await conn.query('DELETE FROM ai_credit_ledger WHERE user_id IN (?)', [ids])
  await conn.query('DELETE FROM ai_end_users WHERE id IN (?)', [ids])
  return ids.length
}

async function deleteProject(projectId, actor, connection = null) {
  const id = safeProjectId(projectId)
  const project = await findProjectById(id, PUBLIC_ADMIN_BASE_URL, connection)
  if (!project || !canAccessProject(actor, project)) throw new Error('AI 项目不存在或无权删除')
  if (!canOperateProject(actor, project)) throw new Error('只能删除自己名下的 AI 项目')
  const [[active]] = await (connection || db()).query('SELECT COUNT(*) AS count FROM ai_builds WHERE project_id = ? AND status IN ("queued","running")', [id])
  if (Number(active?.count || 0) > 0) throw new Error('该项目存在排队中或构建中的任务，请先结束任务后再删除')
  const [[paymentOrders]] = await (connection || db()).query(
    `SELECT COUNT(*) AS count FROM ai_payment_orders
     WHERE user_id IN (SELECT id FROM ai_end_users WHERE source_project_id = ?)`,
    [id],
  )
  if (Number(paymentOrders?.count || 0) > 0) throw new Error('该项目下已有会员支付订单，为保留支付和财务记录，不能删除项目')
  if (authorizationClient) await assertProjectUserRetention(connection || db(), id)
  if (resourcesRuntime && !connection) return resourcesRuntime.removeProject(id, project.organizationId, conn => deleteProject(id, actor, conn))
  const quotaReleased = await releaseProjectQuotaAtCenter(id)
  const conn = connection || await db().getConnection()
  try {
    if (!connection) await conn.beginTransaction()
    const deletedUsers = await deleteEndUsersByProject(conn, id)
    await conn.query('DELETE FROM ai_builds WHERE project_id = ?', [id])
    await conn.query('DELETE FROM ai_projects WHERE id = ?', [id])
    if (!connection) await conn.commit()
    return { id, deleted: true, deletedEndUsers: deletedUsers }
  } catch (err) {
    if (!connection) await conn.rollback()
    if (quotaReleased) await reserveProjectQuotaAtCenter(id).catch((restoreErr) => {
      writeAppLog('supplier-quota', `恢复项目额度失败 ${id}: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`)
    })
    throw err
  } finally {
    if (!connection) conn.release()
  }
}

async function deleteUserAccount(userId, actor) {
  const id = String(userId || '').trim()
  if (!id) throw new Error('账号不存在')
  if (id === actor.id) throw new Error('不能删除当前登录账号')
  const user = await findUserById(id)
  if (!user) throw new Error('账号不存在或已被删除')
  if (actor.organizationContext?.dataScope !== 'platform' && user.primaryOrganizationId !== actor.organizationContext?.organizationId) throw new Error('不能删除其他组织的后台账号')
  if (isSuperAdminUser(user)) throw new Error('内置超级管理员不能删除')
  assertCanManageUser(actor, user, user)
  const [[projectRow]] = await db().query('SELECT COUNT(*) AS count FROM ai_projects WHERE owner_user_id = ?', [id])
  if (Number(projectRow?.count || 0) > 0) throw new Error('该账号名下还有 AI 项目，请先删除或转移项目')
  const [[buildRow]] = await db().query('SELECT COUNT(*) AS count FROM ai_builds WHERE owner_user_id = ?', [id])
  if (Number(buildRow?.count || 0) > 0) throw new Error('该账号还有构建记录，请先删除相关项目或构建记录')
  const [[endUserRow]] = await db().query('SELECT COUNT(*) AS count FROM ai_end_users WHERE source_agent_id = ?', [id])
  if (Number(endUserRow?.count || 0) > 0) throw new Error('该账号下还有终端用户，请先处理终端用户后再删除')
  const [[paymentConfigRow]] = await db().query('SELECT COUNT(*) AS count FROM ai_payment_configs WHERE owner_user_id = ?', [id])
  if (Number(paymentConfigRow?.count || 0) > 0) throw new Error('该账号还有支付配置，请保留账号以便处理支付订单和回调')
  const [[paymentOrderRow]] = await db().query('SELECT COUNT(*) AS count FROM ai_payment_orders WHERE owner_user_id = ?', [id])
  if (Number(paymentOrderRow?.count || 0) > 0) throw new Error('该账号还有支付订单，不能删除')
  await db().query('DELETE FROM ai_users WHERE id = ?', [id])
  return { id, deleted: true }
}

async function assertProjectQuota(ownerUserId, existingProject) {
  if (existingProject) return
  await assertOrganizationQuota(ownerUserId, 'projects')
  const owner = await findUserById(ownerUserId)
  if (!owner || owner.role !== 'agent' || owner.maxProjects <= 0) return
  const usage = await getAgentUsage(ownerUserId)
  if (usage.projects >= owner.maxProjects) throw new Error(`代理项目数已达上限：${usage.projects}/${owner.maxProjects}`)
}

async function assertBuildQuota(ownerUserId) {
  await assertOrganizationQuota(ownerUserId, 'builds')
  const owner = await findUserById(ownerUserId)
  if (!owner || owner.role !== 'agent' || owner.maxBuilds <= 0) return
  const usage = await getAgentUsage(ownerUserId)
  if (usage.builds >= owner.maxBuilds) throw new Error(`代理打包次数已达上限：${usage.builds}/${owner.maxBuilds}`)
}

async function getUserBySession(req) {
  const token = readCookie(req, ADMIN_SESSION_COOKIE)
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  if (Date.now() - session.createdAt > 1000 * 60 * 60 * 24) {
    sessions.delete(token)
    return null
  }
  const user = await findUserById(session.userId)
  return user?.status !== 'disabled' ? enrichUserContext(user) : null
}

async function enrichUserContext(user) {
  if (!user) return null
  const organizationContext = await buildOrganizationContext(user, organizationRepository, { getSupplierLicense })
  return { ...user, organizationContext }
}

setAuthDependencies({
  getUserBySession,
  getEffectivePermissionKeys,
  permissionByKey,
  getEndUserByToken,
  getSupplierLicense,
  findCenterSupplierById,
  authorizeOfficialService,
  ensureOfficialSupplierRegistration: root => ensureOfficialSupplierRegistration(db(), root),
  getClientAuthorization: createClientAuthorization({ client: authorizationClient, repository: organizationRepository, ownerForUser: keyOwnerUserIdForEndUser }),
})

setRedeemCodeDependencies({
  findEndUserById,
  findEndUserWithMembershipById,
  keyOwnerUserIdForEndUser,
  appendCreditLedger,
  sanitizeEndUser,
})


function projectToBrand(project, publicUrls = {}) {
  const publicUpdateBaseUrl = publicUrls.updateBaseUrl || PUBLIC_UPDATE_BASE_URL
  const publicAdminBaseUrl = publicUrls.adminBaseUrl || PUBLIC_ADMIN_BASE_URL
  return {
    aiProjectId: project.id,
    appName: project.appName,
    brandName: project.brandName,
    shortName: project.shortName || project.brandName,
    description: project.description || `${project.appName} Desktop`,
    appId: project.appId,
    configDirName: project.configDirName,
    logoUrl: canonicalizePublicUploadUrl(project.logoUrl, publicAdminBaseUrl) || undefined,
    iconUrl: canonicalizePublicUploadUrl(project.iconUrl, publicAdminBaseUrl) || undefined,
    contactQrUrl: canonicalizePublicUploadUrl(project.contactQrUrl, publicAdminBaseUrl) || undefined,
    loginLogoUrl: canonicalizePublicUploadUrl(project.loginLogoUrl || project.logoUrl, publicAdminBaseUrl) || undefined,
    loginDesign: normalizeLoginDesign(project.loginDesign),
    loginTitle: project.loginTitle || project.appName || undefined,
    loginSubtitle: project.loginSubtitle || project.description || undefined,
    loginHeroTitle: project.loginHeroTitle || undefined,
    loginHeroSubtitle: project.loginHeroSubtitle || undefined,
    aboutText: project.aboutText || undefined,
    officialSiteUrl: project.officialSiteUrl || undefined,
    docsUrl: project.docsUrl || undefined,
    modelTutorialUrl: project.modelTutorialUrl || undefined,
    menus: Array.isArray(project.menus) ? project.menus : [],
    themeColor: project.themeColor || '#2563eb',
    showGithubLink: false,
    updateUrl: `${publicUpdateBaseUrl.replace(/\/$/, '')}/${project.id}/`,
    clientApiUrl: publicAdminBaseUrl,
    sourceProjectId: project.id,
    sourceAgentId: project.ownerUserId || '',
    sourceSupplierId: BUILD_CENTER_SUPPLIER_ID || '',
    clientMode: 'personal',
  }
}

async function projectToBuildCenterBrand(project, publicUrls = {}) {
  const brand = projectToBrand(project, publicUrls)
  brand.clientMode = 'personal'
  return resolveBuildBrandAssets(brand, localUploadUrlToBuildAssetUrl)
}

function normalizeClientMenus(value) {
  const raw = typeof value === 'string' ? parseJson(value, []) : value
  if (!Array.isArray(raw)) return []
  return raw.map((item, index) => {
    const normalized = {
      key: String(item?.key || `menu-${index + 1}`).trim().slice(0, 48),
      label: String(item?.label || '').trim().slice(0, 40),
      visible: item?.visible !== false,
      order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index + 1,
      type: item?.type === 'external' ? 'external' : 'route',
      path: String(item?.path || '').trim().slice(0, 160),
      url: String(item?.url || '').trim().slice(0, 300),
      openMode: item?.openMode === 'internal' ? 'internal' : 'system',
      showAddressBar: item?.showAddressBar !== false,
    }
    if (!normalized.visible) return normalized.key ? normalized : null
    if (normalized.type === 'external') return normalized.key && normalized.label && normalized.url ? normalized : null
    return normalized.key && normalized.label && normalized.path ? normalized : null
  }).filter(Boolean)
}

async function validateProject(input, currentUser, existingProject = null, publicAdminBaseUrl = PUBLIC_ADMIN_BASE_URL) {
  const id = safeProjectId(input.id || input.aiProjectId)
  const appName = String(input.appName || '').trim()
  const brandName = String(input.brandName || appName).trim()
  const generatedAppId = `com.agent.ai.${id.replace(/_/g, '-')}`
  const generatedConfigDirName = `.${id.replace(/_/g, '-')}`
  const configDirName = generatedConfigDirName
  if (!appName) throw new Error('应用名称不能为空')
  if (!brandName) throw new Error('品牌名称不能为空')
  if (!/^\.[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}$/.test(configDirName)) {
    throw new Error('本地数据目录格式不正确，例如 .wanjing')
  }

  const currentOwnerUserId = currentUser.organizationContext?.legacyOwnerUserId || currentUser.id
  const platformScope = currentUser.organizationContext?.dataScope === 'platform'
  let ownerUserId = existingProject?.ownerUserId || currentOwnerUserId
  if (platformScope && input.ownerUserId) {
    const owner = await findUserById(String(input.ownerUserId))
    const isSelfAdminOwner = owner?.id === currentOwnerUserId && owner.role === 'admin'
    if (!owner || (!isSelfAdminOwner && owner.role !== 'agent') || owner.status === 'disabled') throw new Error('项目归属账号不存在或已禁用')
    ownerUserId = owner.id
  }
  if (!platformScope) ownerUserId = currentOwnerUserId

  return {
    id,
    ownerUserId,
    organizationId: currentUser.organizationContext?.organizationId || existingProject?.organizationId || '',
    clientMode: 'personal',
    appName,
    brandName,
    shortName: String(input.shortName || brandName).trim(),
    description: String(input.description || `${appName} Desktop`).trim(),
    appId: existingProject?.appId || generatedAppId,
    configDirName,
    logoUrl: canonicalizePublicUploadUrl(input.logoUrl, publicAdminBaseUrl),
    iconUrl: canonicalizePublicUploadUrl(input.iconUrl, publicAdminBaseUrl),
    contactQrUrl: canonicalizePublicUploadUrl(input.contactQrUrl, publicAdminBaseUrl),
    loginLogoUrl: canonicalizePublicUploadUrl(input.loginLogoUrl || input.logoUrl, publicAdminBaseUrl),
    loginDesign: normalizeLoginDesign(input.loginDesign ?? existingProject?.loginDesign),
    loginTitle: String(input.loginTitle || appName).trim().slice(0, 160),
    loginSubtitle: String(input.loginSubtitle || `${appName} Desktop`).trim().slice(0, 255),
    loginHeroTitle: String(input.loginHeroTitle || '').trim().slice(0, 255),
    loginHeroSubtitle: String(input.loginHeroSubtitle || '').trim().slice(0, 500),
    aboutText: String(input.aboutText || '').trim(),
    officialSiteUrl: String(input.officialSiteUrl || '').trim(),
    docsUrl: String(input.docsUrl || '').trim(),
    modelTutorialUrl: String(input.modelTutorialUrl || '').trim(),
    menus: normalizeClientMenus(input.menus || input.clientMenus || []),
    themeColor: String(input.themeColor || '#2563eb').trim(),
    showGithubLink: false,
    status: input.status === 'disabled' ? 'disabled' : 'enabled',
  }
}

async function findProjectById(id, publicAdminBaseUrl = PUBLIC_ADMIN_BASE_URL, connection = null) {
  const [rows] = await (connection || db()).query('SELECT * FROM ai_projects WHERE id = ? LIMIT 1', [id])
  return normalizeProject(rows[0], publicAdminBaseUrl)
}

async function listProjectsForUser(user, publicAdminBaseUrl = PUBLIC_ADMIN_BASE_URL) {
  const ownerUserId = user.organizationContext?.legacyOwnerUserId || user.id
  const organizationId = String(user.organizationContext?.organizationId || '').trim()
  const platformScope = user.organizationContext?.dataScope === 'platform'
  const sql = platformScope
    ? `SELECT p.*, u.username AS owner_username, u.display_name AS owner_display_name, u.role AS owner_role,
        CASE WHEN p.owner_user_id = ? THEN 1 ELSE 0 END AS can_operate
       FROM ai_projects p
       LEFT JOIN ai_users u ON u.id = p.owner_user_id
       ORDER BY p.created_at DESC`
    : `SELECT p.*, u.username AS owner_username, u.display_name AS owner_display_name, u.role AS owner_role,
        1 AS can_operate
       FROM ai_projects p
       LEFT JOIN ai_users u ON u.id = p.owner_user_id
       WHERE p.organization_id = ? OR (p.organization_id='' AND p.owner_user_id = ?)
       ORDER BY p.created_at DESC`
  const params = platformScope ? [ownerUserId] : [organizationId, ownerUserId]
  const [rows] = await db().query(sql, params)
  return rows.map(row => normalizeProject(row, publicAdminBaseUrl))
}

async function upsertProject(input, user, existingProject = null, publicAdminBaseUrl = PUBLIC_ADMIN_BASE_URL) {
  const project = await validateProject(input, user, existingProject, publicAdminBaseUrl)
  const policy = normalizeClientPolicy(input.clientPolicy === undefined ? existingProject?.clientPolicy : input.clientPolicy)
  await assertProjectQuota(project.ownerUserId, existingProject)
  const quotaReserved = await reserveProjectQuotaAtCenter(project.id, existingProject)
  const write = async connection => {
    await connection.query(
      `INSERT INTO ai_projects (
        id, owner_user_id, organization_id, client_mode, app_name, brand_name, short_name, description, app_id, config_dir_name,
        logo_url, icon_url, contact_qr_url, login_logo_url, login_design, login_title, login_subtitle,
        login_hero_title, login_hero_subtitle, about_text, official_site_url, docs_url, model_tutorial_url,
        client_menus, theme_color, show_github_link, status, client_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        owner_user_id = VALUES(owner_user_id),
        organization_id = VALUES(organization_id),
        client_mode = VALUES(client_mode),
        app_name = VALUES(app_name),
        brand_name = VALUES(brand_name),
        short_name = VALUES(short_name),
        description = VALUES(description),
        app_id = VALUES(app_id),
        config_dir_name = VALUES(config_dir_name),
        logo_url = VALUES(logo_url),
        icon_url = VALUES(icon_url),
        contact_qr_url = VALUES(contact_qr_url),
        login_logo_url = VALUES(login_logo_url),
        login_design = VALUES(login_design),
        login_title = VALUES(login_title),
        login_subtitle = VALUES(login_subtitle),
        login_hero_title = VALUES(login_hero_title),
        login_hero_subtitle = VALUES(login_hero_subtitle),
        about_text = VALUES(about_text),
        official_site_url = VALUES(official_site_url),
        docs_url = VALUES(docs_url),
        model_tutorial_url = VALUES(model_tutorial_url),
        client_menus = VALUES(client_menus),
        theme_color = VALUES(theme_color),
        show_github_link = VALUES(show_github_link),
        status = VALUES(status),
        client_policy_json = VALUES(client_policy_json)`,
      [
        project.id,
        project.ownerUserId,
        project.organizationId,
        project.clientMode,
        project.appName,
        project.brandName,
        project.shortName,
        project.description,
        project.appId,
        project.configDirName,
        project.logoUrl,
        project.iconUrl,
        project.contactQrUrl,
        project.loginLogoUrl,
        project.loginDesign,
        project.loginTitle,
        project.loginSubtitle,
        project.loginHeroTitle,
        project.loginHeroSubtitle,
        project.aboutText,
        project.officialSiteUrl,
        project.docsUrl,
        project.modelTutorialUrl,
        JSON.stringify(project.menus || []),
        project.themeColor,
        project.showGithubLink ? 1 : 0,
        project.status,
        JSON.stringify(policy),
      ],
    )
    return findProjectById(project.id, publicAdminBaseUrl, connection)
  }
  try {
    if (resourcesRuntime) return await resourcesRuntime.project(project.id, project.organizationId, write)
    return await write(db())
  } catch (err) {
    if (quotaReserved) await releaseProjectQuotaAtCenter(project.id).catch((releaseErr) => {
      writeAppLog('supplier-quota', `释放失败项目额度 ${project.id}: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`)
    })
    if (err?.code === 'ER_DUP_ENTRY') throw new Error('项目 ID、App ID 或本地数据目录已被占用')
    throw err
  }
}

async function upsertCenterProject(supplierId, brand, authorizationOrganizationId = undefined) {
  const originalProjectId = safeProjectId(brand?.aiProjectId || brand?.id)
  const id = centerProjectId(supplierId, originalProjectId)
  if (authorizationOrganizationId) assertRecordedOrganization(await findProjectById(id), authorizationOrganizationId)
  const appName = String(brand?.appName || brand?.brandName || id).trim()
  const brandName = String(brand?.brandName || appName).trim()
  const appId = `com.agent.center.${id.replace(/_/g, '-')}`.slice(0, 160)
  const configDirName = `.${originalProjectId.replace(/_/g, '-')}`.slice(0, 63)
  await db().query(
    `INSERT INTO ai_projects (
      id, owner_user_id, organization_id, client_mode, app_name, brand_name, short_name, description, app_id, config_dir_name,
      logo_url, icon_url, contact_qr_url, login_design, about_text, official_site_url, docs_url, model_tutorial_url,
      client_menus, theme_color, show_github_link, status
    ) VALUES (?, 'admin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'enabled')
    ON DUPLICATE KEY UPDATE
      app_name = VALUES(app_name),
      organization_id = VALUES(organization_id),
      client_mode = VALUES(client_mode),
      brand_name = VALUES(brand_name),
      short_name = VALUES(short_name),
      description = VALUES(description),
      logo_url = VALUES(logo_url),
      icon_url = VALUES(icon_url),
      contact_qr_url = VALUES(contact_qr_url),
      login_design = VALUES(login_design),
      about_text = VALUES(about_text),
      official_site_url = VALUES(official_site_url),
      docs_url = VALUES(docs_url),
      model_tutorial_url = VALUES(model_tutorial_url),
      client_menus = VALUES(client_menus),
      theme_color = VALUES(theme_color),
      status = 'enabled'`,
    [
      id,
      authorizationOrganizationId || supplierId,
      'personal',
      appName,
      brandName,
      String(brand?.shortName || brandName).trim(),
      String(brand?.description || `${appName} Desktop`).trim(),
      appId,
      configDirName,
      String(brand?.logoUrl || '').trim(),
      String(brand?.iconUrl || '').trim(),
      String(brand?.contactQrUrl || '').trim(),
      normalizeLoginDesign(brand?.loginDesign),
      String(brand?.aboutText || '').trim(),
      String(brand?.officialSiteUrl || '').trim(),
      String(brand?.docsUrl || '').trim(),
      String(brand?.modelTutorialUrl || '').trim(),
      JSON.stringify(Array.isArray(brand?.menus) ? brand.menus : []),
      String(brand?.themeColor || '#1677ff').trim(),
    ],
  )
  return findProjectById(id)
}

async function createCenterBuild(input, supplier) {
  const supplierId = safeCenterId(supplier?.id || input?.supplierId || '', '供应商 ID')
  const localBuildId = String(input?.localBuildId || '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{1,119}$/.test(localBuildId)) throw new Error('本地构建 ID 不合法')
  const brand = input?.brand && typeof input.brand === 'object' ? input.brand : null
  if (!brand) throw new Error('缺少品牌配置')
  normalizeLoginDesign(brand.loginDesign)
  const [existingRows] = await db().query(
    'SELECT * FROM ai_builds WHERE center_supplier_id = ? AND center_local_build_id = ? LIMIT 1',
    [supplierId, localBuildId],
  )
  if (existingRows[0]) { assertRecordedOrganization(existingRows[0], supplier.authorizationOrganizationId); return normalizeBuild(existingRows[0]) }
  const originalProjectId = safeProjectId(brand.aiProjectId || brand.id)
  if (!supplier.authorizationOrganizationId) await reserveCenterSupplierProject(supplier, originalProjectId, input?.projectIds || [originalProjectId])
  const project = await upsertCenterProject(supplierId, brand, supplier.authorizationOrganizationId)
  const centerBrand = preserveSubmittedLoginBrandFields(projectToBrand(project), brand)
  centerBrand.updateUrl = brand.updateUrl || centerBrand.updateUrl
  centerBrand.clientApiUrl = brand.clientApiUrl || BUILD_CENTER_PUBLIC_URL || PUBLIC_ADMIN_BASE_URL
  centerBrand.sourceSupplierId = supplierId
  centerBrand.sourceAgentId = normalizeSourceText(brand.sourceAgentId || input?.requestedBy || '', 80)
  centerBrand.sourceProjectId = originalProjectId
  centerBrand.sourceBuildId = localBuildId
  centerBrand.centerProjectId = project.id

  const id = crypto.randomUUID()
  const buildVersion = String(input?.version || await getSourceVersion() || '')
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    const [supplierRows] = await connection.query(
      'SELECT max_builds FROM ai_center_suppliers WHERE id = ? LIMIT 1 FOR UPDATE',
      [supplierId],
    )
    if (!supplierRows[0]) throw new Error('供应商不存在')
    const [lockedExistingRows] = await connection.query(
      'SELECT * FROM ai_builds WHERE center_supplier_id = ? AND center_local_build_id = ? LIMIT 1',
      [supplierId, localBuildId],
    )
    const transactionExistingBuild = lockedExistingRows[0] || null
    if (transactionExistingBuild) {
      assertRecordedOrganization(transactionExistingBuild, supplier.authorizationOrganizationId)
      await connection.commit()
      return normalizeBuild(transactionExistingBuild)
    }
    const [[buildUsage]] = await connection.query(
      'SELECT COUNT(*) AS count FROM ai_builds WHERE center_supplier_id = ?',
      [supplierId],
    )
    const actualBuildCount = Number(buildUsage?.count || 0)
    if (!supplier.authorizationOrganizationId) assertSupplierBuildQuota(actualBuildCount, supplierRows[0].max_builds)
    await connection.query(
      `INSERT INTO ai_builds (
        id, project_id, owner_user_id, organization_id, requested_by, version, status, log, brand_json, center_supplier_id, center_local_build_id
      ) VALUES (?, ?, 'admin', ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      [
        id,
        project.id,
        supplier.authorizationOrganizationId || supplierId,
        String(input?.requestedBy || supplierId).slice(0, 64),
        buildVersion,
        `[center] Submitted by ${supplierId}, local build ${localBuildId}\n`,
        JSON.stringify(centerBrand),
        supplierId,
        localBuildId,
      ],
    )
    await connection.query(
      'UPDATE ai_center_suppliers SET build_count = ?, last_build_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [actualBuildCount + 1, supplierId],
    )
    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
  return findBuildById(id)
}

async function createBuild(project, requestedBy, version = '', options = {}) {
  const buildVersion = String(version || await getSourceVersion() || '')
  const { id, fingerprint } = buildResourceIdentity(project, requestedBy, buildVersion, resourcesRuntime ? options.idempotencyKey : undefined)
  const write = async connection => {
    if (resourcesRuntime) {
      const active = await lockBuildProject(connection, project)
      if (active) return { ...normalizeBuild(active), alreadyActive: true }
    }
    await connection.query(
    `INSERT INTO ai_builds (id, project_id, owner_user_id, organization_id, requested_by, version, status, log)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', '')`,
    [id, project.id, project.ownerUserId || '', project.organizationId || '', requestedBy || null, buildVersion],
  )
    return findBuildById(id, connection)
  }
  if (resourcesRuntime) return resourcesRuntime.build(id, project.organizationId, fingerprint, write)
  return write(db())
}

async function prepareBuildCenterBrand(build, project, user, publicUrls = {}) {
  const brand = await projectToBuildCenterBrand(project, publicUrls)
  const sourceInfo = await getSourceVersionInfo()
  await applyProjectReleaseFeedUrl(brand, project.id, publicUrls.updateBaseUrl)
  brand.releaseNotes = sourceInfo.releaseNotes || ''
  brand.releaseHistory = Array.isArray(sourceInfo.history) ? sourceInfo.history : []
  brand.sourceAgentId = project.ownerUserId || user?.id || ''
  brand.sourceProjectId = project.id
  brand.sourceBuildId = build.id
  return brand
}

async function submitBuildToCenter(build, project, user, publicUrls = {}) {
  const config = await getBuildCenterConfig()
  if (!config.enabled) return build
  try {
    const brand = await prepareBuildCenterBrand(build, project, user, publicUrls)
    build = await updateBuild(build.id, { brand })
    const scope = authorizationClient ? await organizationRepository.findOrganizationById(project.organizationId) : null
    const submitted = await buildCenterApi('/api/center/builds', {
      supplierId: config.supplierId,
      localBuildId: build.id,
      requestedBy: user?.username || user?.id || build.requestedBy || '',
      version: build.version,
      brand,
      projectIds: await listLocalSupplierProjectIds(),
    }, config, scope?.externalId || (scope?.agentLevel === 2 ? scope.id : null))
    const nextLog = `${build.log || ''}[admin] Submitted to Agent build center: ${submitted.id}\n`
    return updateBuild(build.id, {
      status: submitted.status || 'queued',
      version: submitted.version || build.version || '',
      brand: submitted.brand || brand,
      remoteBuildId: submitted.id,
      log: nextLog,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return updateBuild(build.id, {
      status: 'failed',
      error: `提交官方构建中心失败：${message}`,
      log: `${build.log || ''}[admin] Failed to submit to Agent build center: ${message}\n`,
      finishedAt: nowIso(),
    })
  }
}

async function resetBuildForRetry(buildId, extraPatch = {}) {
  return updateBuild(buildId, {
    status: 'queued',
    error: '',
    log: '',
    artifactDir: '',
    publicUrl: '',
    releaseUrl: '',
    releaseStatus: '',
    releaseError: '',
    files: [],
    transferProgress: null,
    claimedBy: '',
    startedAt: null,
    finishedAt: null,
    releasedAt: null,
    ...extraPatch,
  })
}

async function findBuildById(id, connection = null) {
  const [rows] = await (connection || db()).query('SELECT * FROM ai_builds WHERE id = ? LIMIT 1', [id])
  return normalizeBuild(rows[0])
}

async function findActiveBuildForProject(projectId, user) {
  const platformScope = user.organizationContext?.dataScope === 'platform'
  const ownerUserId = user.organizationContext?.legacyOwnerUserId || user.id
  const sql = platformScope
    ? `SELECT * FROM ai_builds WHERE project_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`
    : `SELECT * FROM ai_builds WHERE project_id = ? AND owner_user_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`
  const params = platformScope ? [projectId] : [projectId, ownerUserId]
  const [rows] = await db().query(sql, params)
  return normalizeBuild(rows[0])
}

function localizeCenterBuildInBackground(local, remote, config) {
  if (localizingBuildIds.has(local.id)) return false
  localizingBuildIds.add(local.id)
  ;(async () => {
    const updateIfActive = async (patch) => {
      const current = await findBuildById(local.id)
      if (!current || (current.status !== 'queued' && current.status !== 'running')) return null
      return updateBuild(local.id, patch)
    }
    try {
      await updateIfActive({
        status: 'running',
        error: '正在同步官方测试包到供应商本地',
        log: `${remote.log || local.log || ''}[admin] 正在同步官方测试包到供应商本地...\n`,
        transferProgress: {
          phase: 'staging',
          status: 'starting',
          currentFile: '',
          currentFileIndex: 0,
          totalFiles: Array.isArray(remote.files) ? remote.files.length : 0,
          currentFilePercent: 0,
          overallPercent: 0,
          transferredBytes: 0,
          totalBytes: 0,
          updatedAt: nowIso(),
        },
      }).catch(() => {})
      const localized = await stageRemoteBuildArtifacts(local, remote)
      await buildCenterApi(`/api/center/builds/${encodeURIComponent(remote.id)}/artifacts/cleanup`, {}, config).catch((err) => {
        console.warn('[ai-admin] Failed to cleanup build center artifact:', err instanceof Error ? err.message : err)
      })
      await updateIfActive({
        status: 'succeeded',
        log: localized.log || remote.log || local.log || '',
        error: '',
        artifactDir: localized.artifactDir || '',
        publicUrl: localized.publicUrl || '',
        releaseUrl: '',
        files: localized.files || [],
        claimedBy: remote.claimedBy || '',
        startedAt: remote.startedAt || null,
        finishedAt: remote.finishedAt || null,
      }).catch(() => {})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await updateIfActive({
        status: 'failed',
        error: `下载官方测试包到本地失败：${message}`,
        log: `${remote.log || local.log || ''}[admin] 下载官方测试包到本地失败：${message}\n`,
        finishedAt: nowIso(),
        transferProgress: {
          phase: 'staging',
          status: 'failed',
          currentFile: '',
          currentFileIndex: 0,
          totalFiles: Array.isArray(remote.files) ? remote.files.length : 0,
          currentFilePercent: 0,
          overallPercent: 0,
          transferredBytes: 0,
          totalBytes: 0,
          error: message,
          updatedAt: nowIso(),
        },
      }).catch(() => {})
    } finally {
      localizingBuildIds.delete(local.id)
    }
  })()
  return true
}

async function syncCenterBuilds({ platformScope = false, ownerUserId = '' } = {}) {
  const config = await getBuildCenterConfig()
  if (!config.enabled) return { configured: false, checked: 0, updated: 0, localizationStarted: 0 }
  const sql = platformScope
    ? `SELECT * FROM ai_builds WHERE remote_build_id IS NOT NULL AND (status IN ('queued','running') OR version IS NULL OR version = '' OR brand_json IS NULL OR JSON_EXTRACT(brand_json, '$.clientMode') IS NULL) ORDER BY created_at DESC LIMIT 100`
    : `SELECT * FROM ai_builds WHERE owner_user_id = ? AND remote_build_id IS NOT NULL AND (status IN ('queued','running') OR version IS NULL OR version = '' OR brand_json IS NULL OR JSON_EXTRACT(brand_json, '$.clientMode') IS NULL) ORDER BY created_at DESC LIMIT 100`
  const params = platformScope ? [] : [ownerUserId]
  const [rows] = await db().query(sql, params)
  const builds = rows.map(normalizeBuild).filter((build) => build?.remoteBuildId)
  if (builds.length === 0) return { configured: true, checked: 0, updated: 0, localizationStarted: 0 }
  let remoteBuilds = []
  try {
    remoteBuilds = await buildCenterApi('/api/center/builds/status', {
      supplierId: config.supplierId,
      buildIds: builds.map((build) => build.remoteBuildId),
    }, config)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[ai-admin] Failed to sync build center status:', message)
    return { configured: true, checked: builds.length, updated: 0, localizationStarted: 0, failed: true, error: message }
  }
  let updated = 0
  let localizationStarted = 0
  const byId = new Map((Array.isArray(remoteBuilds) ? remoteBuilds : []).map((build) => [build.id, build]))
  for (const local of builds) {
    const remote = byId.get(local.remoteBuildId)
    if (!remote) continue
    const metadataPatch = remoteBuildMetadataPatch(local, remote)
    if (Object.keys(metadataPatch).length > 0) { await updateBuild(local.id, metadataPatch); updated += 1 }
    if (!['queued', 'running'].includes(local.status)) continue
    if (remote.status === 'succeeded' && remote.publicUrl && Array.isArray(remote.files) && remote.files.length > 0) {
      if (localizeCenterBuildInBackground({ ...local, ...metadataPatch }, remote, config)) localizationStarted += 1
      continue
    }
    await updateBuild(local.id, {
      ...metadataPatch,
      status: remote.status,
      log: remote.log || local.log || '',
      error: remote.error || '',
      artifactDir: remote.artifactDir || '',
      publicUrl: remote.publicUrl || '',
      releaseUrl: '',
      files: Array.isArray(remote.files) ? remote.files : [],
      claimedBy: remote.claimedBy || '',
      startedAt: remote.startedAt || null,
      finishedAt: remote.finishedAt || null,
    })
    updated += 1
  }
  return { configured: true, checked: builds.length, updated, localizationStarted }
}

async function syncCenterBuildsForUser(user) {
  return syncCenterBuilds({
    platformScope: user.organizationContext?.dataScope === 'platform',
    ownerUserId: user.organizationContext?.legacyOwnerUserId || user.id,
  })
}

async function listBuildsForUser(user, options = {}) {
  if (options.sync !== false) await syncCenterBuildsForUser(user)
  const ownerUserId = user.organizationContext?.legacyOwnerUserId || user.id
  const platform = user.organizationContext?.dataScope === 'platform'
  let sql = platform
    ? `SELECT b.*, p.app_name AS project_name, p.client_mode AS project_client_mode, u.username AS owner_username, u.display_name AS owner_display_name, u.role AS owner_role,
        CASE WHEN b.owner_user_id = ? AND (b.center_supplier_id IS NULL OR b.center_supplier_id = '') THEN 1 ELSE 0 END AS can_operate
       FROM ai_builds b
       LEFT JOIN ai_projects p ON p.id = b.project_id
       LEFT JOIN ai_users u ON u.id = b.owner_user_id`
    : `SELECT b.*, p.app_name AS project_name, p.client_mode AS project_client_mode, u.username AS owner_username, u.display_name AS owner_display_name, u.role AS owner_role,
        1 AS can_operate
       FROM ai_builds b
       LEFT JOIN ai_projects p ON p.id = b.project_id
       LEFT JOIN ai_users u ON u.id = b.owner_user_id
       WHERE b.owner_user_id = ?`
  const params = [ownerUserId], filterParams = []
  const filters = []
  const status = String(options.status || '').trim()
  const search = buildListSearch(options, {
    buildId: ['b.id'],
    project: ['b.project_id', 'p.app_name'],
    version: ['b.version'],
    owner: ['u.username', 'u.display_name'],
  })
  if (search.clause) { filters.push(search.clause); filterParams.push(...search.params) }
  if (status && status !== 'all') { filters.push('b.status=?'); filterParams.push(status) }
  if (filters.length) sql += `${platform ? ' WHERE ' : ' AND '}${filters.join(' AND ')}`
  const paged = isPaginationRequested(options), pagination = parsePagination(options)
  let total = 0
  if (paged) {
    const countWhere = [platform ? null : 'b.owner_user_id=?', ...filters].filter(Boolean)
    const countParams = platform ? filterParams : [ownerUserId, ...filterParams]
    const [[countRow]] = await db().query(`SELECT COUNT(*) AS total FROM ai_builds b LEFT JOIN ai_projects p ON p.id=b.project_id LEFT JOIN ai_users u ON u.id=b.owner_user_id${countWhere.length ? ` WHERE ${countWhere.join(' AND ')}` : ''}`, countParams)
    total = Number(countRow?.total || 0)
  }
  sql += ` ORDER BY b.created_at DESC${paged ? ' LIMIT ? OFFSET ?' : ''}`
  const [rows] = await db().query(sql, [...params, ...filterParams, ...(paged ? [pagination.pageSize, pagination.offset] : [])])
  const items = rows.map(normalizeBuild)
  return paged ? pageResult(items, total, pagination) : items
}

async function updateBuild(buildId, patch) {
  const fields = []
  const values = []
  const map = {
    version: 'version',
    status: 'status',
    log: 'log',
    error: 'error',
    artifactDir: 'artifact_dir',
    publicUrl: 'public_url',
    releaseUrl: 'release_url',
    releaseStatus: 'release_status',
    releaseError: 'release_error',
    files: 'files',
    transferProgress: 'transfer_progress',
    brand: 'brand_json',
    remoteBuildId: 'remote_build_id',
    centerSupplierId: 'center_supplier_id',
    centerLocalBuildId: 'center_local_build_id',
    claimedBy: 'claimed_by',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    releasedAt: 'released_at',
  }
  for (const [key, column] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      fields.push(`${column} = ?`)
      if (key === 'files') values.push(JSON.stringify(patch[key] || []))
      else if (key === 'transferProgress') values.push(patch[key] ? JSON.stringify(patch[key]) : null)
      else if (key === 'brand') values.push(patch[key] ? JSON.stringify(patch[key]) : null)
      else if (key === 'startedAt' || key === 'finishedAt' || key === 'releasedAt') values.push(toMysqlDateTime(patch[key]))
      else values.push(patch[key])
    }
  }
  if (fields.length === 0) return findBuildById(buildId)
  values.push(buildId)
  await db().query(`UPDATE ai_builds SET ${fields.join(', ')} WHERE id = ?`, values)
  return findBuildById(buildId)
}

async function touchWorker(workerId, patch = {}) {
  const metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : {}
  await db().query(
    `INSERT INTO ai_workers (id, status, current_build_id, last_seen_at, last_claimed_at, last_completed_at, metadata_json)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP(3), ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      current_build_id = VALUES(current_build_id),
      last_seen_at = CURRENT_TIMESTAMP(3),
      last_claimed_at = COALESCE(VALUES(last_claimed_at), last_claimed_at),
      last_completed_at = COALESCE(VALUES(last_completed_at), last_completed_at),
      metadata_json = CASE WHEN JSON_LENGTH(COALESCE(VALUES(metadata_json), JSON_OBJECT())) > 0 THEN VALUES(metadata_json) ELSE metadata_json END`,
    [
      workerId,
      patch.status || 'online',
      patch.currentBuildId ?? '',
      patch.claimed ? toMysqlDateTime(nowIso()) : null,
      patch.completed ? toMysqlDateTime(nowIso()) : null,
      JSON.stringify(metadata),
    ],
  )
  return findWorkerById(workerId)
}

async function findWorkerById(workerId) {
  const [rows] = await db().query('SELECT * FROM ai_workers WHERE id = ? LIMIT 1', [workerId])
  return normalizeWorker(rows[0])
}

async function listWorkers() {
  const managedWorkerPlaceholders = MANAGED_WORKER_ID_LIST.map(() => '?').join(', ')
  const [rows] = await db().query(`
    SELECT
      ai_workers.*,
      TIMESTAMPDIFF(SECOND, last_seen_at, CURRENT_TIMESTAMP(3)) AS heartbeat_age_seconds
    FROM ai_workers
    WHERE id IN (${managedWorkerPlaceholders})
    ORDER BY last_seen_at DESC, updated_at DESC
  `, MANAGED_WORKER_ID_LIST)
  return rows.map((row) => {
    const worker = normalizeWorker(row)
    const heartbeatAgeSeconds = Number(row.heartbeat_age_seconds)
    const online = Number.isFinite(heartbeatAgeSeconds) && heartbeatAgeSeconds >= 0 && heartbeatAgeSeconds <= 120
    return { ...worker, status: online ? 'online' : 'offline', online }
  })
}

async function listVisibleWorkers() {
  const config = await getBuildCenterConfig()
  if (!config.enabled) return listWorkers()
  try {
    const workers = await buildCenterApi('/api/center/workers', { supplierId: config.supplierId }, config)
    return filterManagedWorkers(workers)
  } catch (err) {
    console.warn('[ai-admin] Failed to load build center workers:', err instanceof Error ? err.message : err)
    return []
  }
}

async function getPlatformSettings(userId = 'platform') {
  const id = String(userId || '').trim()
  if (id && id !== 'platform') {
    const [userRows] = await db().query('SELECT * FROM ai_platform_settings WHERE id = ? LIMIT 1', [id])
    if (userRows[0]) return normalizePlatformSettings(userRows[0])
  }
  const [globalRows] = await db().query('SELECT * FROM ai_platform_settings WHERE id = ? LIMIT 1', ['platform'])
  return normalizePlatformSettings(globalRows[0] || {})
}

async function getPlatformSettingsForDisplay(userId = 'platform') {
  return withEffectiveBuildCenterSettings(await getPlatformSettings(userId), {
    url: BUILD_CENTER_URL,
    supplierId: BUILD_CENTER_SUPPLIER_ID,
    token: BUILD_CENTER_TOKEN,
  })
}

async function getConfiguredSelfUpdateManifestUrl() {
  const settings = await getPlatformSettings('platform')
  return String(settings.selfUpdateManifestUrl || '').trim() || SELF_UPDATE_MANIFEST_URL
}

async function saveSelfUpdateManifestUrl(input) {
  const manifestUrl = String(input?.manifestUrl || '').trim()
  if (manifestUrl && !/^https?:\/\//i.test(manifestUrl)) {
    throw new Error('更新源必须是 http 或 https 地址')
  }
  await db().query(
    `INSERT INTO ai_platform_settings (id, self_update_manifest_url)
     VALUES ('platform', ?)
     ON DUPLICATE KEY UPDATE self_update_manifest_url = VALUES(self_update_manifest_url)`,
    [manifestUrl],
  )
  return {
    manifestUrl: await getConfiguredSelfUpdateManifestUrl(),
    customManifestUrl: manifestUrl,
    envManifestUrl: SELF_UPDATE_MANIFEST_URL,
  }
}

async function savePlatformSettings(userId, input) {
  const id = String(userId || '').trim()
  if (!id) throw new Error('账号不存在')
  const existing = await getPlatformSettings(id)
  const rawBuildCenterUrl = String(input.buildCenterUrl || '').trim().replace(/\/$/, '')
  const rawBuildCenterToken = String(input.buildCenterToken || '').trim()
  const rawBuildCenterSupplierId = String(input.buildCenterSupplierId || '').trim()
  const modelGatewayBaseUrl = normalizeHttpUrl(input.modelGatewayBaseUrl || defaultPlatformSettings.modelGatewayBaseUrl)
  const modelUsageBaseUrl = normalizeHttpUrl(input.modelUsageBaseUrl || defaultPlatformSettings.modelUsageBaseUrl)
  const modelGatewayKey = preserveConfiguredSecret(input.modelGatewayKey, existing.modelGatewayKey, Boolean(modelGatewayBaseUrl))
  const modelPointsPerUsd = Number(input.modelPointsPerUsd || defaultPlatformSettings.modelPointsPerUsd)
  const artifactStorageMode = normalizeArtifactStorageMode(input.artifactStorageMode || existing.artifactStorageMode)
  const ossAccessKeyId = String(input.ossAccessKeyId || '').trim()
  const rawOssAccessKeySecret = String(input.ossAccessKeySecret || '').trim()
  const ossAccessKeySecret = rawOssAccessKeySecret || (ossAccessKeyId ? existing.ossAccessKeySecret : '')
  const ossBucket = String(input.ossBucket || '').trim()
  const ossEndpoint = normalizeOssEndpoint(input.ossEndpoint || '')
  const ossPublicBaseUrl = normalizeOssPublicBaseUrl({
    bucket: ossBucket,
    endpoint: ossEndpoint,
    publicBaseUrl: input.ossPublicBaseUrl,
  })
  const ossPrefix = trimSlashes(input.ossPrefix || defaultPlatformSettings.ossPrefix)
  const smtpHost = String(input.smtpHost || '').trim()
  const smtpPort = Math.max(1, Math.min(65535, Number(input.smtpPort || existing.smtpPort || defaultPlatformSettings.smtpPort)))
  const smtpSecure = Boolean(input.smtpSecure ?? existing.smtpSecure ?? defaultPlatformSettings.smtpSecure)
  const smtpUser = String(input.smtpUser || '').trim()
  const rawSmtpPass = String(input.smtpPass || '').trim()
  const smtpPass = rawSmtpPass || (smtpHost && smtpUser ? existing.smtpPass : '')
  const smtpFromName = String(input.smtpFromName || defaultPlatformSettings.smtpFromName).trim().slice(0, 120)
  const smtpFromEmail = String(input.smtpFromEmail || '').trim()
  if (!Number.isFinite(modelPointsPerUsd) || modelPointsPerUsd <= 0) throw new Error('积分折算比例必须大于 0')
  if (artifactStorageMode === 'oss' && (!ossAccessKeyId || !ossAccessKeySecret || !ossBucket || !ossEndpoint || !ossPublicBaseUrl)) {
    throw new Error('选择 OSS 托管时，AccessKeyId、AccessKey Secret、Bucket 和 Endpoint 必须填写完整')
  }
  const hasSmtpInput = Boolean(smtpHost || smtpUser || smtpPass || smtpFromEmail)
  if (hasSmtpInput) {
    if (!smtpHost || !smtpPort || !smtpUser || !smtpPass || !smtpFromEmail) throw new Error('邮件服务的 SMTP Host、端口、账号、密码和发件邮箱必须填写完整')
    normalizeEmail(smtpFromEmail)
  }
  const buildCenterUrl = normalizeSecureBuildCenterUrl(rawBuildCenterUrl)
  const buildCenterSupplierId = rawBuildCenterSupplierId
  const buildCenterToken = rawBuildCenterToken || (buildCenterUrl && buildCenterSupplierId ? existing.buildCenterToken : '')
  const hasBuildCenterInput = Boolean(buildCenterUrl || buildCenterToken || buildCenterSupplierId)
  let buildCenterConfig = { url: '', token: '', supplierId: '' }
  if (hasBuildCenterInput) {
    buildCenterConfig = normalizeBuildCenterConfig({
      url: buildCenterUrl,
      token: buildCenterToken,
      supplierId: buildCenterSupplierId,
    })
    if (!buildCenterConfig.enabled) throw new Error('官方构建中心 URL、Supplier ID 和 Token 必须填写完整')
  }
  const settings = normalizePlatformSettings({
    system_name: input.systemName,
    system_subtitle: input.systemSubtitle,
    login_title: input.loginTitle,
    login_subtitle: input.loginSubtitle,
    login_background_url: input.loginBackgroundUrl,
    login_panel_color: input.loginPanelColor,
    login_content_json: input.loginContent,
    primary_color: input.primaryColor,
    logo_text: input.logoText,
    login_crystal_faces_json: Object.prototype.hasOwnProperty.call(input, 'crystalFaceTexts') ? input.crystalFaceTexts : existing.crystalFaceTexts,
    build_center_url: buildCenterConfig.url,
    build_center_supplier_id: buildCenterConfig.supplierId,
    build_center_token: buildCenterConfig.token,
    artifact_storage_mode: artifactStorageMode,
    oss_access_key_id: ossAccessKeyId,
    oss_access_key_secret: ossAccessKeySecret,
    oss_bucket: ossBucket,
    oss_endpoint: ossEndpoint,
    oss_public_base_url: ossPublicBaseUrl,
    oss_prefix: ossPrefix,
    model_gateway_base_url: modelGatewayBaseUrl,
    model_usage_base_url: modelUsageBaseUrl,
    model_gateway_key: modelGatewayKey,
    model_points_per_usd: modelPointsPerUsd,
    smtp_host: smtpHost,
    smtp_port: smtpPort,
    smtp_secure: smtpSecure ? 1 : 0,
    smtp_user: smtpUser,
    smtp_pass: smtpPass,
    smtp_from_name: smtpFromName,
    smtp_from_email: smtpFromEmail,
  })
  await db().query(
    `INSERT INTO ai_platform_settings
      (id, system_name, system_subtitle, login_title, login_subtitle, login_background_url, login_panel_color, login_content_json, primary_color, logo_text, login_crystal_faces_json, build_center_url, build_center_supplier_id, build_center_token, artifact_storage_mode, oss_access_key_id, oss_access_key_secret, oss_bucket, oss_endpoint, oss_public_base_url, oss_prefix, model_gateway_base_url, model_usage_base_url, model_gateway_key, model_points_per_usd, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from_name, smtp_from_email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      system_name = VALUES(system_name),
      system_subtitle = VALUES(system_subtitle),
      login_title = VALUES(login_title),
      login_subtitle = VALUES(login_subtitle),
      login_background_url = VALUES(login_background_url),
      login_panel_color = VALUES(login_panel_color),
      login_content_json = VALUES(login_content_json),
      primary_color = VALUES(primary_color),
      logo_text = VALUES(logo_text),
      login_crystal_faces_json = VALUES(login_crystal_faces_json),
      build_center_url = VALUES(build_center_url),
      build_center_supplier_id = VALUES(build_center_supplier_id),
      build_center_token = VALUES(build_center_token),
      artifact_storage_mode = VALUES(artifact_storage_mode),
      oss_access_key_id = VALUES(oss_access_key_id),
      oss_access_key_secret = IF(VALUES(oss_access_key_secret) = '', oss_access_key_secret, VALUES(oss_access_key_secret)),
      oss_bucket = VALUES(oss_bucket),
      oss_endpoint = VALUES(oss_endpoint),
      oss_public_base_url = VALUES(oss_public_base_url),
      oss_prefix = VALUES(oss_prefix),
      model_gateway_base_url = VALUES(model_gateway_base_url),
      model_usage_base_url = VALUES(model_usage_base_url),
      model_gateway_key = IF(VALUES(model_gateway_key) = '', model_gateway_key, VALUES(model_gateway_key)),
      model_points_per_usd = VALUES(model_points_per_usd),
      smtp_host = VALUES(smtp_host),
      smtp_port = VALUES(smtp_port),
      smtp_secure = VALUES(smtp_secure),
      smtp_user = VALUES(smtp_user),
      smtp_pass = IF(VALUES(smtp_pass) = '', smtp_pass, VALUES(smtp_pass)),
      smtp_from_name = VALUES(smtp_from_name),
      smtp_from_email = VALUES(smtp_from_email)`,
    [
      id,
      settings.systemName,
      settings.systemSubtitle,
      settings.loginTitle,
      settings.loginSubtitle,
      settings.loginBackgroundUrl,
      settings.loginPanelColor,
      JSON.stringify(settings.loginContent),
      settings.primaryColor,
      settings.logoText,
      JSON.stringify(settings.crystalFaceTexts),
      settings.buildCenterUrl,
      settings.buildCenterSupplierId,
      settings.buildCenterToken,
      settings.artifactStorageMode,
      settings.ossAccessKeyId,
      settings.ossAccessKeySecret,
      settings.ossBucket,
      settings.ossEndpoint,
      settings.ossPublicBaseUrl,
      settings.ossPrefix,
      settings.modelGatewayBaseUrl,
      settings.modelUsageBaseUrl,
      settings.modelGatewayKey,
      settings.modelPointsPerUsd,
      settings.smtpHost,
      settings.smtpPort,
      settings.smtpSecure ? 1 : 0,
      settings.smtpUser,
      settings.smtpPass,
      settings.smtpFromName,
      settings.smtpFromEmail,
    ],
  )
  return getPlatformSettings(id)
}

function normalizeRecordStatus(value, fallback = 'enabled') {
  const status = String(value || fallback).trim()
  return status === 'disabled' ? 'disabled' : 'enabled'
}

function normalizeProviderModelType(value) {
  const type = String(value || 'text').trim()
  return ['text', 'image', 'video', 'audio', 'search'].includes(type) ? type : 'text'
}

function normalizeModelEndpointPath(value, modelType = 'text') {
  const raw = String(value || '').trim()
  if (!raw) {
    if (modelType === 'image') return '/images/generations'
    if (modelType === 'search') return '/v1/web-search'
    return '/chat/completions'
  }
  if (!raw.startsWith('/')) throw new Error('模型接口端点必须以 / 开头')
  return raw.slice(0, 255)
}

function normalizeModelProviderProtocol(value) {
  const protocol = String(value || 'openai-compatible').trim()
  if (protocol !== 'openai-compatible') throw new Error('暂仅支持 OpenAI 兼容协议')
  return protocol
}

function normalizePositiveInt(value, fallback = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.floor(number))
}

function normalizeSortOrder(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(-999999, Math.min(999999, Math.floor(number)))
}

function normalizeProviderId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64)
}

function normalizeModelCapabilities(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',')
  return [...new Set(raw.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 20)
}

function normalizeBillingType(value) {
  const type = String(value || 'per_token').trim()
  if (type === 'per_request') return 'per_request'
  if (type === IMAGE_BILLING_TYPE) return IMAGE_BILLING_TYPE
  return 'per_token'
}

function syncHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}

function providerSyncPayload(item = {}) {
  const provider = normalizeModelProvider({
    id: item.id,
    name: item.name,
    protocol: item.protocol,
    base_url: item.baseUrl ?? item.base_url,
    status: item.status,
    is_default: item.isDefault ?? item.is_default,
    timeout_ms: item.timeoutMs ?? item.timeout_ms,
    sort_order: item.sortOrder ?? item.sort_order,
    notes: item.notes,
  })
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    status: provider.status,
    isDefault: Boolean(provider.isDefault),
    timeoutMs: Number(provider.timeoutMs || 120000),
    sortOrder: Number(provider.sortOrder || 0),
    notes: provider.notes || '',
  }
}

function modelSyncPayload(item = {}) {
  const model = normalizeProviderModel({
    id: item.id,
    provider_id: item.providerId ?? item.provider_id,
    model_id: item.modelId ?? item.model_id,
    display_name: item.displayName ?? item.display_name,
    description: item.description,
    model_type: item.modelType ?? item.model_type,
    endpoint_path: item.endpointPath ?? item.endpoint_path,
    status: item.status,
    is_default: item.isDefault ?? item.is_default,
    capabilities: item.capabilities,
    reasoning_config: item.reasoning ?? item.reasoningConfig ?? item.reasoning_config,
    context_window: item.contextWindow ?? item.context_window,
    sort_order: item.sortOrder ?? item.sort_order,
  })
  return {
    id: model.id,
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    description: model.description || '',
    modelType: model.modelType,
    endpointPath: model.endpointPath || normalizeModelEndpointPath('', model.modelType),
    status: model.status,
    isDefault: Boolean(model.isDefault),
    capabilities: normalizeModelCapabilities(model.capabilities).sort(),
    reasoning: normalizeModelReasoning(model.reasoning),
    contextWindow: Number(model.contextWindow || 0),
    sortOrder: Number(model.sortOrder || 0),
  }
}

function pricingSyncPayload(item = {}) {
  const inputSale = item.inputPointsPerMTokens ?? item.input_points_per_m_tokens
  const outputSale = item.outputPointsPerMTokens ?? item.output_points_per_m_tokens
  const requestSale = item.pointsPerRequest ?? item.points_per_request
  const resolutionSale = item.resolutionPoints ?? item.resolution_points
  const rule = normalizeModelPricingRule({
    id: item.id,
    provider_id: item.providerId ?? item.provider_id,
    provider_model_id: item.providerModelId ?? item.provider_model_id,
    billing_type: item.billingType ?? item.billing_type,
    input_points_per_m_tokens: inputSale,
    output_points_per_m_tokens: outputSale,
    points_per_request: requestSale,
    resolution_points: resolutionSale,
    input_cost_points_per_m_tokens: item.inputCostPointsPerMTokens ?? item.input_cost_points_per_m_tokens ?? inputSale,
    output_cost_points_per_m_tokens: item.outputCostPointsPerMTokens ?? item.output_cost_points_per_m_tokens ?? outputSale,
    cost_points_per_request: item.costPointsPerRequest ?? item.cost_points_per_request ?? requestSale,
    resolution_cost_points: item.resolutionCostPoints ?? item.resolution_cost_points ?? resolutionSale,
    consumption_multiplier: item.consumptionMultiplier ?? item.consumption_multiplier ?? 1,
    status: item.status,
  })
  return {
    id: rule.id,
    providerId: rule.providerId,
    providerModelId: rule.providerModelId,
    billingType: rule.billingType,
    inputPointsPerMTokens: Number(rule.inputPointsPerMTokens || 0),
    outputPointsPerMTokens: Number(rule.outputPointsPerMTokens || 0),
    pointsPerRequest: Number(rule.pointsPerRequest || 0),
    resolutionPoints: rule.resolutionPoints || {},
    inputCostPointsPerMTokens: Number(rule.inputCostPointsPerMTokens || 0),
    outputCostPointsPerMTokens: Number(rule.outputCostPointsPerMTokens || 0),
    costPointsPerRequest: Number(rule.costPointsPerRequest || 0),
    resolutionCostPoints: rule.resolutionCostPoints || {},
    consumptionMultiplier: rule.consumptionMultiplier,
    status: rule.status,
  }
}

function isSyncEditable(row = {}, localPayload, remoteHash) {
  const currentHash = syncHash(localPayload)
  const previousHash = String(row.center_sync_hash || '')
  return !previousHash ? currentHash === remoteHash : currentHash === previousHash
}

async function seedDefaultModelProviderData() {
  // Providers, keys, models, and pricing are managed explicitly in the admin console,
  // except the system-level image generation records which are seeded and pinned here.
  await db().query(
    `INSERT INTO ai_model_providers (id, name, protocol, base_url, status, is_default, timeout_ms, sort_order, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      protocol = VALUES(protocol),
      base_url = VALUES(base_url),
      status = VALUES(status),
      timeout_ms = VALUES(timeout_ms),
      sort_order = VALUES(sort_order),
      notes = VALUES(notes)`,
    [
      SYSTEM_IMAGE_PROVIDER.id,
      SYSTEM_IMAGE_PROVIDER.name,
      SYSTEM_IMAGE_PROVIDER.protocol,
      SYSTEM_IMAGE_PROVIDER.baseUrl,
      SYSTEM_IMAGE_PROVIDER.status,
      SYSTEM_IMAGE_PROVIDER.isDefault ? 1 : 0,
      SYSTEM_IMAGE_PROVIDER.timeoutMs,
      SYSTEM_IMAGE_PROVIDER.sortOrder,
      SYSTEM_IMAGE_PROVIDER.notes,
    ],
  )
  await db().query(
    `INSERT INTO ai_provider_models (id, provider_id, model_id, display_name, description, model_type, endpoint_path, status, is_default, capabilities, context_window, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      model_id = VALUES(model_id),
      display_name = VALUES(display_name),
      description = VALUES(description),
      model_type = VALUES(model_type),
      endpoint_path = VALUES(endpoint_path),
      status = VALUES(status),
      is_default = VALUES(is_default),
      capabilities = VALUES(capabilities),
      context_window = VALUES(context_window),
      sort_order = VALUES(sort_order)`,
    [
      SYSTEM_IMAGE_MODEL.id,
      SYSTEM_IMAGE_MODEL.providerId,
      SYSTEM_IMAGE_MODEL.modelId,
      SYSTEM_IMAGE_MODEL.displayName,
      SYSTEM_IMAGE_MODEL.description,
      SYSTEM_IMAGE_MODEL.modelType,
      SYSTEM_IMAGE_MODEL.endpointPath,
      SYSTEM_IMAGE_MODEL.status,
      SYSTEM_IMAGE_MODEL.isDefault ? 1 : 0,
      JSON.stringify(SYSTEM_IMAGE_MODEL.capabilities),
      SYSTEM_IMAGE_MODEL.contextWindow,
      SYSTEM_IMAGE_MODEL.sortOrder,
    ],
  )
  await migrateLegacySystemImageRecords(db())
  await db().query(
    `INSERT INTO ai_model_pricing_rules (id, provider_id, provider_model_id, billing_type, resolution_points, resolution_cost_points, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      billing_type = VALUES(billing_type)`,
    [
      SYSTEM_IMAGE_PRICING.id,
      SYSTEM_IMAGE_PROVIDER.id,
      SYSTEM_IMAGE_MODEL.id,
      SYSTEM_IMAGE_PRICING.billingType,
      JSON.stringify(SYSTEM_IMAGE_PRICING.resolutionPoints),
      JSON.stringify(SYSTEM_IMAGE_PRICING.resolutionCostPoints),
      SYSTEM_IMAGE_PRICING.status,
    ],
  )
  const preferredImageCapabilityId = 'system-capability-seedream-pro'
  await db().query(`INSERT INTO ai_model_task_capabilities
    (id,organization_id,provider_model_id,task_type,protocol_adapter,connection_role,endpoint_path,config_json,status)
    VALUES (?,'',?,'image_generation','openai.images','image','/images/generations',JSON_OBJECT(),'enabled')
    ON DUPLICATE KEY UPDATE protocol_adapter=VALUES(protocol_adapter),endpoint_path=VALUES(endpoint_path)`,
  [preferredImageCapabilityId, SYSTEM_IMAGE_MODEL.id])
  const [[imageCapability]] = await db().query("SELECT id FROM ai_model_task_capabilities WHERE provider_model_id=? AND task_type='image_generation'", [SYSTEM_IMAGE_MODEL.id])
  const imageCapabilityId = imageCapability.id
  const preferredImagePlanId = 'system-plan-seedream-pro'
  await db().query(`INSERT IGNORE INTO ai_model_pricing_plans
    (id,organization_id,provider_model_id,capability_id,task_type,version,status,consumption_multiplier)
    VALUES (?,'',?,?,'image_generation',1,'enabled',1)`, [preferredImagePlanId, SYSTEM_IMAGE_MODEL.id, imageCapabilityId])
  const [[imagePlan]] = await db().query('SELECT id FROM ai_model_pricing_plans WHERE capability_id=?', [imageCapabilityId])
  const imagePlanId = imagePlan.id
  for (const [index, tier] of ['1K','1.5K','2K'].entries()) {
    const componentId = `system-pc-seedream-${tier.replace('.','-')}`
    await db().query(`DELETE own FROM ai_model_pricing_components own
      JOIN ai_model_pricing_components existing ON existing.plan_id=own.plan_id AND existing.id<>own.id
        AND existing.meter_code='image' AND existing.charge_phase='usage'
        AND JSON_UNQUOTE(JSON_EXTRACT(existing.dimensions_json,'$.resolution'))=?
      WHERE own.id=? AND own.plan_id=?`, [tier, componentId, imagePlanId])
    const [[existing]] = await db().query(`SELECT id FROM ai_model_pricing_components WHERE plan_id=? AND meter_code='image'
      AND charge_phase='usage' AND JSON_UNQUOTE(JSON_EXTRACT(dimensions_json,'$.resolution'))=? LIMIT 1`, [imagePlanId, tier])
    if (!existing) await db().query(`INSERT INTO ai_model_pricing_components
      (id,plan_id,meter_code,charge_phase,unit_size,dimensions_json,cost_amount,cost_currency,sale_points,status,sort_order)
      VALUES (?,?,'image','usage',1,?,?,'CNY',?,'enabled',?)`,
    [componentId, imagePlanId, JSON.stringify({ resolution: tier }), SYSTEM_IMAGE_PRICING.resolutionCostPoints[tier], SYSTEM_IMAGE_PRICING.resolutionPoints[tier], index * 10])
  }
  await db().query(`INSERT INTO ai_model_providers
    (id,name,protocol,base_url,status,is_default,timeout_ms,sort_order,notes)
    VALUES (?,?, 'openai-compatible','https://api.minimax.chat','enabled',0,120000,110,?)
    ON DUPLICATE KEY UPDATE name=VALUES(name),protocol=VALUES(protocol),base_url=VALUES(base_url),timeout_ms=VALUES(timeout_ms),notes=VALUES(notes)`,
  [SYSTEM_AUDIO_PROVIDER_ID, 'MiniMax（语音与音色）', '系统内置语音服务；仅需配置唯一 Key，其余参数可编辑但不可删除'])
  await db().query(`INSERT INTO ai_provider_models
    (id,provider_id,model_id,display_name,description,model_type,endpoint_path,status,is_default,capabilities,context_window,sort_order)
    VALUES (?,?,?,'MiniMax Speech 2.8 Turbo','系统内置语音合成与私有音色模型','audio','/v1/t2a_v2','enabled',1,?,0,110)
    ON DUPLICATE KEY UPDATE model_id=VALUES(model_id),display_name=VALUES(display_name),description=VALUES(description),model_type=VALUES(model_type),endpoint_path=VALUES(endpoint_path),capabilities=VALUES(capabilities)`,
  [SYSTEM_AUDIO_MODEL_ID, SYSTEM_AUDIO_PROVIDER_ID, 'speech-2.8-turbo', JSON.stringify(['speech_synthesis','voice_cloning'])])
  await db().query(`INSERT INTO ai_model_upstream_accounts
    (id,organization_id,owner_user_id,provider_id,name,region,status,notes)
    VALUES (?,'','admin',?,'MiniMax 固定语音账号','','enabled','系统内置资源边界，仅需配置唯一 Key，不允许删除')
    ON DUPLICATE KEY UPDATE name=VALUES(name),notes=VALUES(notes)`, [SYSTEM_AUDIO_ACCOUNT_ID, SYSTEM_AUDIO_PROVIDER_ID])
  await db().query(`INSERT INTO ai_model_pricing_rules
    (id,provider_id,provider_model_id,billing_type,points_per_request,voice_preview_points,voice_activation_points,voice_points_per_1k_chars,consumption_multiplier,status)
    VALUES (?,?,?,'per_request',0,3,20,3,1,'enabled')
    ON DUPLICATE KEY UPDATE billing_type=VALUES(billing_type)`, [SYSTEM_AUDIO_PRICING_ID, SYSTEM_AUDIO_PROVIDER_ID, SYSTEM_AUDIO_MODEL_ID])
  const preferredAudioCapabilityId = 'system-capability-minimax-speech'
  await db().query(`INSERT INTO ai_model_task_capabilities
    (id,organization_id,provider_model_id,task_type,protocol_adapter,upstream_account_id,connection_role,endpoint_path,config_json,status)
    VALUES (?,'',?,'speech_synthesis','minimax.t2a',?,'voice','/v1/t2a_v2',JSON_OBJECT(),'enabled')
    ON DUPLICATE KEY UPDATE protocol_adapter=VALUES(protocol_adapter),upstream_account_id=VALUES(upstream_account_id),endpoint_path=VALUES(endpoint_path)`,
  [preferredAudioCapabilityId, SYSTEM_AUDIO_MODEL_ID, SYSTEM_AUDIO_ACCOUNT_ID])
  const [[audioCapability]] = await db().query("SELECT id FROM ai_model_task_capabilities WHERE provider_model_id=? AND task_type='speech_synthesis'", [SYSTEM_AUDIO_MODEL_ID])
  const audioCapabilityId = audioCapability.id
  const preferredAudioPlanId = 'system-plan-minimax-speech'
  await db().query(`INSERT IGNORE INTO ai_model_pricing_plans
    (id,organization_id,provider_model_id,capability_id,task_type,version,status,consumption_multiplier)
    VALUES (?,'',?,?,'speech_synthesis',1,'enabled',1)`, [preferredAudioPlanId, SYSTEM_AUDIO_MODEL_ID, audioCapabilityId])
  const [[audioPlan]] = await db().query('SELECT id FROM ai_model_pricing_plans WHERE capability_id=?', [audioCapabilityId])
  const audioPlanId = audioPlan.id
  for (const item of [
    ['preview','billable_characters','preview',1000,3,10],
    ['activation','resource_activation','activation',1,20,20],
    ['usage','billable_characters','usage',1000,3,30],
  ]) {
    const componentId = `system-pc-minimax-${item[0]}`
    await db().query(`DELETE own FROM ai_model_pricing_components own
      JOIN ai_model_pricing_components existing ON existing.plan_id=own.plan_id AND existing.id<>own.id
        AND existing.meter_code=? AND existing.charge_phase=?
        AND JSON_LENGTH(COALESCE(existing.dimensions_json,JSON_OBJECT()))=0
      WHERE own.id=? AND own.plan_id=?`, [item[1], item[2], componentId, audioPlanId])
    const [[existing]] = await db().query(`SELECT id FROM ai_model_pricing_components
      WHERE plan_id=? AND meter_code=? AND charge_phase=? AND JSON_LENGTH(COALESCE(dimensions_json,JSON_OBJECT()))=0 LIMIT 1`, [audioPlanId, item[1], item[2]])
    if (!existing) await db().query(`INSERT INTO ai_model_pricing_components
      (id,plan_id,meter_code,charge_phase,unit_size,cost_amount,cost_currency,sale_points,status,sort_order)
      VALUES (?,?,?,?,?,0,'CNY',?,'enabled',?)`, [componentId, audioPlanId, item[1], item[2], item[3], item[4], item[5]])
  }
}
async function listModelProviders(actor = null, scope = null) {
  const rows = await queryModelProviders(db(), actor, scope)
  return rows.map((row) => ({
    ...normalizeModelProvider(row),
    keyCount: Number(row.key_count || 0),
    modelCount: Number(row.model_count || 0),
  }))
}

async function findModelProviderById(id) {
  const [rows] = await db().query(`SELECT p.*,EXISTS(SELECT 1 FROM ai_provider_models m
    JOIN ai_model_task_capabilities c ON c.provider_model_id=m.id
    WHERE m.provider_id=p.id AND c.protocol_adapter='minimax.t2a') AS has_managed_voice
    FROM ai_model_providers p WHERE p.id = ? LIMIT 1`, [String(id || '').trim()])
  return normalizeModelProvider(rows[0])
}

async function enableModelProvider(id, scope = null) {
  const provider = await findModelProviderById(id)
  if (!provider) throw new Error('服务商不存在')
  assertModelServiceRecordInScope(provider, scope, '服务商')
  await db().query('UPDATE ai_model_providers SET status = "enabled" WHERE id = ?', [provider.id])
  return findModelProviderById(provider.id)
}

async function saveModelProvider(input = {}, scope = null) {
  const existingId = normalizeProviderId(input.id)
  const id = existingId || crypto.randomUUID()
  const name = String(input.name || '').trim()
  if (!name) throw new Error('请输入服务商名称')
  const protocol = normalizeModelProviderProtocol(input.protocol)
  const baseUrl = normalizeHttpUrl(input.baseUrl || input.base_url || '')
  if (!baseUrl) throw new Error('请输入服务商接口地址')
  const status = normalizeRecordStatus(input.status)
  const isDefault = Boolean(input.isDefault ?? input.is_default)
  const timeoutMs = Math.max(10000, Math.min(600000, normalizePositiveInt(input.timeoutMs ?? input.timeout_ms, 120000)))
  const sortOrder = normalizeSortOrder(input.sortOrder ?? input.sort_order)
  const notes = String(input.notes || '').trim().slice(0, 255)
  if (existingId) {
    const existing = await findModelProviderById(existingId)
    if (existing) assertModelServiceRecordInScope(existing, scope, '服务商')
  }
  const organizationId = scope?.organizationId || ''
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    await guardSupplyProviderConnection(conn, id, { baseUrl, protocol })
    if (isDefault) {
      await conn.query(
        organizationId
          ? 'UPDATE ai_model_providers SET is_default = 0 WHERE id <> ? AND organization_id = ?'
          : 'UPDATE ai_model_providers SET is_default = 0 WHERE id <> ? AND organization_id = ""',
        organizationId ? [id, organizationId] : [id],
      )
    }
    await conn.query(
      `INSERT INTO ai_model_providers
        (id, name, protocol, base_url, status, is_default, timeout_ms, sort_order, notes, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        protocol = VALUES(protocol),
        base_url = VALUES(base_url),
        status = VALUES(status),
        is_default = VALUES(is_default),
        timeout_ms = VALUES(timeout_ms),
        sort_order = VALUES(sort_order),
        notes = VALUES(notes)`,
      [id, name, protocol, baseUrl, status, isDefault ? 1 : 0, timeoutMs, sortOrder, notes, organizationId],
    )
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  return findModelProviderById(id)
}

async function listModelProviderKeys(providerId = '', actor = null) {
  return listProviderKeys(db(), providerId, actor)
}

async function saveModelProviderKey(providerId, input = {}, actor = null, scope = null) {
  return saveProviderKey({ db, findModelProviderById, assertModelServiceRecordInScope, voiceCredentialVault,
    normalizeRecordStatus, normalizePositiveInt, previewSecret }, providerId, input, actor, scope)
}

async function listProviderModels(providerId = '', scope = null) {
  const params = []
  const conditions = ['m.archived_at IS NULL']
  const orgFilter = modelServiceScopeWhere(scope, 'm')
  if (orgFilter.clause) {
    conditions.push(orgFilter.clause)
    params.push(...orgFilter.params)
  }
  if (providerId) {
    conditions.push('m.provider_id = ?')
    params.push(providerId)
  }
  let sql = `SELECT m.*, p.name AS provider_name
    FROM ai_provider_models m
    JOIN ai_model_providers p ON p.id = m.provider_id`
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`
  sql += ' ORDER BY p.sort_order ASC, m.sort_order ASC, m.created_at ASC'
  const [rows] = await db().query(sql, params)
  return rows.map(normalizeProviderModel)
}

async function saveProviderModel(input = {}, scope = null) {
  const provider = await findModelProviderById(input.providerId || input.provider_id)
  if (!provider) throw new Error('服务商不存在')
  assertModelServiceRecordInScope(provider, scope, '服务商')
  const modelId = String(input.modelId || input.model_id || '').trim()
  if (!modelId) throw new Error('请输入模型 ID')
  const explicitId = String(input.id || '').trim()
  const candidateId = explicitId || `${provider.id}-${modelId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64) || crypto.randomUUID()
  const displayName = String(input.displayName || input.display_name || modelId).trim().slice(0, 160)
  const description = String(input.description || '').trim().slice(0, 1000)
  const modelType = normalizeProviderModelType(input.modelType || input.model_type)
  const endpointPath = normalizeModelEndpointPath(input.endpointPath || input.endpoint_path, modelType)
  const status = normalizeRecordStatus(input.status)
  const isDefault = Boolean(input.isDefault ?? input.is_default)
  const capabilities = normalizeModelCapabilities(input.capabilities)
  const reasoning = normalizeModelReasoning(input.reasoning ?? input.reasoningConfig ?? input.reasoning_config)
  if (reasoning.enabled && !capabilities.includes('reasoning')) capabilities.push('reasoning')
  const contextWindow = normalizePositiveInt(input.contextWindow ?? input.context_window, 0)
  const sortOrder = normalizeSortOrder(input.sortOrder ?? input.sort_order)
  const id = await saveProviderModelRecord(db(), {
    id: candidateId, explicitId, provider, modelId, displayName, description,
    modelType, endpointPath, status, isDefault, capabilities, reasoning, contextWindow, sortOrder,
  }, scope)
  const [rows] = await db().query(
    `SELECT m.*, p.name AS provider_name
     FROM ai_provider_models m
     JOIN ai_model_providers p ON p.id = m.provider_id
     WHERE m.id = ? AND m.archived_at IS NULL LIMIT 1`,
    [id],
  )
  return normalizeProviderModel(rows[0])
}

async function findProviderModelById(id) {
  const [rows] = await db().query(
    `SELECT m.*, p.name AS provider_name
     FROM ai_provider_models m
     JOIN ai_model_providers p ON p.id = m.provider_id
     WHERE m.id = ? AND m.archived_at IS NULL LIMIT 1`,
    [String(id || '').trim()],
  )
  return normalizeProviderModel(rows[0])
}

async function enableProviderModel(id, scope = null) {
  const existing = await findProviderModelById(id)
  if (!existing) throw new Error('模型不存在')
  assertModelServiceRecordInScope(existing, scope, '模型')
  await db().query('UPDATE ai_provider_models SET status = "enabled" WHERE id = ?', [existing.id])
  await db().query('UPDATE ai_model_task_capabilities SET status = "enabled" WHERE provider_model_id = ?', [existing.id])
  const [rows] = await db().query(
    `SELECT m.*, p.name AS provider_name
     FROM ai_provider_models m
     JOIN ai_model_providers p ON p.id = m.provider_id
     WHERE m.id = ? AND m.archived_at IS NULL LIMIT 1`,
    [String(id || '').trim()],
  )
  return normalizeProviderModel(rows[0])
}

async function testProviderModelConnectivity(input = {}, actor = null, scope = null) {
  const provider = await findModelProviderById(input.providerId || input.provider_id)
  if (!provider) throw new Error('服务商不存在')
  assertModelServiceRecordInScope(provider, scope, '服务商')
  const modelId = String(input.modelId || input.model_id || '').trim()
  if (!modelId) throw new Error('请输入上游模型 ID')
  const modelType = normalizeProviderModelType(input.modelType || input.model_type)
  const endpointPath = normalizeModelEndpointPath(input.endpointPath || input.endpoint_path, modelType)
  if (!['text', 'search'].includes(modelType)) {
    return {
      skipped: true,
      message: '当前仅对文本模型执行自动连通性测试，图片/视频/音频模型先保存分类和端点，调用方式确定后再补充测试。',
    }
  }
  const scopeModelId = await findKeyScopeModelId(db(), provider.id, modelId, provider.organizationId || '')
  const keyRows = await selectEligibleModelKeys(db(), { ownerUserId: actor?.id || 'admin', providerId: provider.id, providerModelId: scopeModelId })
  const key = await materializeModelProviderKey(keyRows[0])
  if (!key?.api_key) throw new Error(`服务商 ${provider.name} 在当前账号下暂无适用于该模型的可用 Key，请检查 Key 池的适用模型配置`)
  const url = `${String(provider.baseUrl || '').replace(/\/$/, '')}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(10000, Math.min(60000, Number(provider.timeoutMs || 30000))))
  try {
    const requestBody = modelType === 'search'
      ? {
          query: '博查搜索连通性测试',
          summary: true,
          freshness: 'noLimit',
          count: 1,
        }
      : {
          model: modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 32,
          temperature: 0,
          stream: false,
        }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${String(key.api_key || '')}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`连通性测试失败 (${response.status})：${text.slice(0, 500) || response.statusText}`)
    }
    let usage = null
    try {
      usage = JSON.parse(text)?.usage || null
    } catch {}
    return {
      ok: true,
      providerId: provider.id,
      modelId,
      endpointPath,
      keyPreview: key.key_preview || previewSecret(key.api_key),
      usage,
      message: modelType === 'search' ? '搜索模型连通性测试通过' : '连通性测试通过',
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('连通性测试超时，请检查服务商地址、模型 ID 或 Key')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function listModelPricingRules(providerId = '', scope = null) {
  const params = []
  const conditions = ['m.archived_at IS NULL']
  const orgFilter = modelServiceScopeWhere(scope, 'r')
  if (orgFilter.clause) {
    conditions.push(orgFilter.clause)
    params.push(...orgFilter.params)
  }
  if (providerId) {
    conditions.push('r.provider_id = ?')
    params.push(providerId)
  }
  let sql = `SELECT r.*, p.name AS provider_name, m.model_id, m.display_name
    FROM ai_model_pricing_rules r
    JOIN ai_model_providers p ON p.id = r.provider_id
    JOIN ai_provider_models m ON m.id = r.provider_model_id`
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`
  sql += ' ORDER BY p.sort_order ASC, m.sort_order ASC, r.created_at ASC'
  const [rows] = await db().query(sql, params)
  return rows.map(normalizeModelPricingRule)
}

async function findModelPricingRuleById(id) {
  const [rows] = await db().query(
    `SELECT r.*, p.name AS provider_name, m.model_id, m.display_name
     FROM ai_model_pricing_rules r
     JOIN ai_model_providers p ON p.id = r.provider_id
     JOIN ai_provider_models m ON m.id = r.provider_model_id
     WHERE r.id = ? LIMIT 1`,
    [String(id || '').trim()],
  )
  return normalizeModelPricingRule(rows[0])
}

async function saveModelPricingRule(input = {}, scope = null) {
  const providerModelId = String(input.providerModelId || input.provider_model_id || '').trim()
  const [modelRows] = await db().query('SELECT * FROM ai_provider_models WHERE id = ? AND archived_at IS NULL LIMIT 1', [providerModelId])
  const model = normalizeProviderModel(modelRows[0])
  if (!model) throw new Error('模型不存在')
  assertModelServiceRecordInScope(model, scope, '模型')
  const billingType = normalizeBillingType(input.billingType || input.billing_type)
  const prices = normalizePricingRulePrices(input, billingType)
  const consumptionMultiplier = normalizeConsumptionMultiplier(input.consumptionMultiplier ?? input.consumption_multiplier, 1)
  const id = String(input.id || '').trim() || crypto.randomUUID()
  const status = normalizeRecordStatus(input.status)
  await db().query(
    `INSERT INTO ai_model_pricing_rules
      (id, provider_id, provider_model_id, billing_type, input_points_per_m_tokens, output_points_per_m_tokens, points_per_request, resolution_points,
       input_cost_points_per_m_tokens, output_cost_points_per_m_tokens, cost_points_per_request, resolution_cost_points, consumption_multiplier, status, organization_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      provider_id = VALUES(provider_id),
      provider_model_id = VALUES(provider_model_id),
      billing_type = VALUES(billing_type),
      input_points_per_m_tokens = VALUES(input_points_per_m_tokens),
      output_points_per_m_tokens = VALUES(output_points_per_m_tokens),
      points_per_request = VALUES(points_per_request),
      resolution_points = VALUES(resolution_points),
      input_cost_points_per_m_tokens = VALUES(input_cost_points_per_m_tokens),
      output_cost_points_per_m_tokens = VALUES(output_cost_points_per_m_tokens),
      cost_points_per_request = VALUES(cost_points_per_request),
      resolution_cost_points = VALUES(resolution_cost_points),
      consumption_multiplier = VALUES(consumption_multiplier),
      status = VALUES(status)`,
    [id, model.providerId, model.id, billingType, prices.inputPointsPerMTokens, prices.outputPointsPerMTokens, prices.pointsPerRequest,
      billingType === IMAGE_BILLING_TYPE ? JSON.stringify(prices.resolutionPoints) : null,
      prices.inputCostPointsPerMTokens, prices.outputCostPointsPerMTokens, prices.costPointsPerRequest,
      billingType === IMAGE_BILLING_TYPE ? JSON.stringify(prices.resolutionCostPoints) : null, consumptionMultiplier, status, model.organizationId || ''],
  )
  const [rows] = await db().query(
    `SELECT r.*, p.name AS provider_name, m.model_id, m.display_name
     FROM ai_model_pricing_rules r
     JOIN ai_model_providers p ON p.id = r.provider_id
     JOIN ai_provider_models m ON m.id = r.provider_model_id
     WHERE r.id = ? LIMIT 1`,
    [id],
  )
  return normalizeModelPricingRule(rows[0])
}

async function enableModelPricingRule(id, scope = null) {
  const existing = await findModelPricingRuleById(id)
  if (!existing) throw new Error('计费规则不存在')
  assertModelServiceRecordInScope(existing, scope, '计费规则')
  await db().query('UPDATE ai_model_pricing_rules SET status = "enabled" WHERE id = ?', [existing.id])
  return findModelPricingRuleById(existing.id)
}

async function exportModelServiceConfigForCenter() {
  return {
    schemaVersion: 2,
    providers: (await listModelProviders()).map(providerSyncPayload),
    models: (await listProviderModels()).map(modelSyncPayload),
    pricingRules: (await listModelPricingRules()).map(pricingSyncPayload),
    v2: await modelServiceV2Sync.exportPacket(),
  }
}

async function syncProvidersFromCenter(remoteProviders = []) {
  const remote = remoteProviders.map(providerSyncPayload).filter((item) => item.id)
  const remoteById = new Map(remote.map((item) => [item.id, { payload: item, hash: syncHash(item) }]))
  const [rows] = await db().query('SELECT * FROM ai_model_providers')
  const localById = new Map(rows.map((row) => [row.id, row]))
  const result = { added: 0, updated: 0, deleted: 0, skipped: 0 }
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    for (const { payload, hash } of remoteById.values()) {
      const local = localById.get(payload.id)
      if (local && !isSyncEditable(local, providerSyncPayload(local), hash)) {
        result.skipped += 1
        continue
      }
      await guardSupplyProviderConnection(conn, payload.id, payload)
      await conn.query(
        `INSERT INTO ai_model_providers
          (id, name, protocol, base_url, status, is_default, timeout_ms, sort_order, notes, center_sync_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          protocol = VALUES(protocol),
          base_url = VALUES(base_url),
          status = VALUES(status),
          is_default = VALUES(is_default),
          timeout_ms = VALUES(timeout_ms),
          sort_order = VALUES(sort_order),
          notes = VALUES(notes),
          center_sync_hash = VALUES(center_sync_hash)`,
        [payload.id, payload.name, payload.protocol, payload.baseUrl, payload.status, payload.isDefault ? 1 : 0, payload.timeoutMs, payload.sortOrder, payload.notes, hash],
      )
      result[local ? 'updated' : 'added'] += 1
    }
    for (const row of rows) {
      if (remoteById.has(row.id)) continue
      const localPayload = providerSyncPayload(row)
      if (!row.center_sync_hash || syncHash(localPayload) !== row.center_sync_hash) {
        result.skipped += 1
        continue
      }
      await guardSupplyProviderDeletion(conn, row.id)
      const [modelRows] = await conn.query('SELECT id FROM ai_provider_models WHERE provider_id = ?', [row.id])
      const modelIds = modelRows.map((item) => item.id).filter(Boolean)
      if (modelIds.length) {
        await conn.query('DELETE FROM ai_end_user_model_access WHERE provider_model_id IN (?)', [modelIds])
        await conn.query('DELETE FROM ai_membership_card_model_access WHERE provider_model_id IN (?)', [modelIds])
        await conn.query('DELETE FROM ai_model_pricing_rules WHERE provider_model_id IN (?)', [modelIds])
      }
      await conn.query('DELETE FROM ai_model_provider_keys WHERE provider_id = ?', [row.id])
      await conn.query('DELETE FROM ai_provider_models WHERE provider_id = ?', [row.id])
      await conn.query('DELETE FROM ai_model_pricing_rules WHERE provider_id = ?', [row.id])
      await conn.query('DELETE FROM ai_model_providers WHERE id = ?', [row.id])
      result.deleted += 1
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  return result
}

async function syncModelsFromCenter(remoteModels = []) {
  const remote = remoteModels.map(modelSyncPayload).filter((item) => item.id && item.providerId)
  const remoteById = new Map(remote.map((item) => [item.id, { payload: item, hash: syncHash(item) }]))
  const [rows] = await db().query('SELECT * FROM ai_provider_models WHERE archived_at IS NULL')
  const localLookup = buildSyncLookup(rows, modelSyncBusinessKey)
  const matchedLocalIds = new Set()
  const result = { added: 0, updated: 0, deleted: 0, skipped: 0 }
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    for (const { payload, hash } of remoteById.values()) {
      const [providerRows] = await conn.query('SELECT id FROM ai_model_providers WHERE id = ? LIMIT 1', [payload.providerId])
      if (!providerRows.length) {
        result.skipped += 1
        continue
      }
      const local = findSyncMatch(payload, localLookup, modelSyncBusinessKey)
      if (local && !isSyncEditable(local, modelSyncPayload(local), hash)) {
        result.skipped += 1
        continue
      }
      if (local?.id) matchedLocalIds.add(local.id)
      if (local?.id) await guardSupplyModelConnection(conn, local.id, payload)
      await conn.query(
        `INSERT INTO ai_provider_models
          (id, provider_id, model_id, display_name, description, model_type, endpoint_path, status, is_default, capabilities, reasoning_config, context_window, sort_order, center_sync_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          provider_id = VALUES(provider_id),
          model_id = VALUES(model_id),
          display_name = VALUES(display_name),
          description = VALUES(description),
          model_type = VALUES(model_type),
          endpoint_path = VALUES(endpoint_path),
          status = VALUES(status),
          is_default = VALUES(is_default),
          capabilities = VALUES(capabilities),
          reasoning_config = VALUES(reasoning_config),
          context_window = VALUES(context_window),
          sort_order = VALUES(sort_order),
          center_sync_hash = VALUES(center_sync_hash)`,
        [local?.id || payload.id, payload.providerId, payload.modelId, payload.displayName, payload.description, payload.modelType, payload.endpointPath, payload.status, payload.isDefault ? 1 : 0, JSON.stringify(payload.capabilities), JSON.stringify(payload.reasoning), payload.contextWindow, payload.sortOrder, hash],
      )
      result[local ? 'updated' : 'added'] += 1
    }
    for (const row of rows) {
      if (shouldRetainMatchedSyncRow(row.id, remoteById, matchedLocalIds)) continue
      const localPayload = modelSyncPayload(row)
      if (!row.center_sync_hash || syncHash(localPayload) !== row.center_sync_hash) {
        result.skipped += 1
        continue
      }
      await guardSupplyModelDeletion(conn, row.id)
      await conn.query('DELETE FROM ai_end_user_model_access WHERE provider_model_id = ?', [row.id])
      await conn.query('DELETE FROM ai_membership_card_model_access WHERE provider_model_id = ?', [row.id])
      await conn.query('DELETE FROM ai_model_pricing_rules WHERE provider_model_id = ?', [row.id])
      await conn.query('DELETE FROM ai_provider_models WHERE id = ?', [row.id])
      result.deleted += 1
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  return result
}

async function syncPricingRulesFromCenter(remoteRules = []) {
  const remote = remoteRules.map(pricingSyncPayload).filter((item) => item.id && item.providerModelId)
  const remoteById = new Map(remote.map((item) => [item.id, { payload: item, hash: syncHash(item) }]))
  const [rows] = await db().query('SELECT * FROM ai_model_pricing_rules')
  const localLookup = buildSyncLookup(rows, pricingSyncBusinessKey)
  const matchedLocalIds = new Set()
  const result = { added: 0, updated: 0, deleted: 0, skipped: 0 }
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    for (const { payload, hash } of remoteById.values()) {
      const [modelRows] = await conn.query('SELECT id FROM ai_provider_models WHERE id = ? LIMIT 1', [payload.providerModelId])
      if (!modelRows.length) {
        result.skipped += 1
        continue
      }
      const local = findSyncMatch(payload, localLookup, pricingSyncBusinessKey)
      if (local && !isSyncEditable(local, pricingSyncPayload(local), hash)) {
        result.skipped += 1
        continue
      }
      if (local?.id) matchedLocalIds.add(local.id)
      await conn.query(
        `INSERT INTO ai_model_pricing_rules
          (id, provider_id, provider_model_id, billing_type, input_points_per_m_tokens, output_points_per_m_tokens, points_per_request, resolution_points,
           input_cost_points_per_m_tokens, output_cost_points_per_m_tokens, cost_points_per_request, resolution_cost_points, consumption_multiplier, status, center_sync_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          provider_id = VALUES(provider_id),
          provider_model_id = VALUES(provider_model_id),
          billing_type = VALUES(billing_type),
          input_points_per_m_tokens = VALUES(input_points_per_m_tokens),
          output_points_per_m_tokens = VALUES(output_points_per_m_tokens),
          points_per_request = VALUES(points_per_request),
          resolution_points = VALUES(resolution_points),
          input_cost_points_per_m_tokens = VALUES(input_cost_points_per_m_tokens),
          output_cost_points_per_m_tokens = VALUES(output_cost_points_per_m_tokens),
          cost_points_per_request = VALUES(cost_points_per_request),
          resolution_cost_points = VALUES(resolution_cost_points),
          consumption_multiplier = VALUES(consumption_multiplier),
          status = VALUES(status),
          center_sync_hash = VALUES(center_sync_hash)`,
        [local?.id || payload.id, payload.providerId, payload.providerModelId, payload.billingType, payload.inputPointsPerMTokens, payload.outputPointsPerMTokens, payload.pointsPerRequest,
          payload.billingType === IMAGE_BILLING_TYPE ? JSON.stringify(payload.resolutionPoints || {}) : null,
          payload.inputCostPointsPerMTokens, payload.outputCostPointsPerMTokens, payload.costPointsPerRequest,
          payload.billingType === IMAGE_BILLING_TYPE ? JSON.stringify(payload.resolutionCostPoints || payload.resolutionPoints || {}) : null,
          payload.consumptionMultiplier, payload.status, hash],
      )
      result[local ? 'updated' : 'added'] += 1
    }
    for (const row of rows) {
      if (shouldRetainMatchedSyncRow(row.id, remoteById, matchedLocalIds)) continue
      const localPayload = pricingSyncPayload(row)
      if (!row.center_sync_hash || syncHash(localPayload) !== row.center_sync_hash) {
        result.skipped += 1
        continue
      }
      await conn.query('DELETE FROM ai_model_pricing_rules WHERE id = ?', [row.id])
      result.deleted += 1
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  return result
}

async function syncModelServiceFromCenter(scope = 'all') {
  const allowedScopes = ['all', 'providers', 'models', 'pricingRules', 'v2']
  const targetScope = allowedScopes.includes(scope) ? scope : 'all'
  const remote = CENTER_SUPPLIER_MANAGEMENT_ENABLED
    ? await exportModelServiceConfigForCenter()
    : await buildCenterApi('/api/center/model-service-config')
  const result = {}
  if (targetScope === 'all' || targetScope === 'providers') result.providers = await syncProvidersFromCenter(remote.providers || [])
  if (targetScope === 'all' || targetScope === 'models') result.models = await syncModelsFromCenter(remote.models || [])
  if (targetScope === 'all' || targetScope === 'pricingRules') result.pricingRules = await syncPricingRulesFromCenter(remote.pricingRules || [])
  if ((targetScope === 'all' || targetScope === 'v2') && remote.v2) result.v2 = await modelServiceV2Sync.apply(remote.v2)
  return result
}

async function getModelServiceUpdateStatus() {
  const remote = CENTER_SUPPLIER_MANAGEMENT_ENABLED
    ? await exportModelServiceConfigForCenter()
    : await buildCenterApi('/api/center/model-service-config')
  const remoteProviders = (remote.providers || []).map(providerSyncPayload).filter((item) => item.id)
  const remoteModels = (remote.models || []).map(modelSyncPayload).filter((item) => item.id)
  const remotePricingRules = (remote.pricingRules || []).map(pricingSyncPayload).filter((item) => item.id)
  const [providerRows, modelRows, pricingRows] = await Promise.all([
    db().query('SELECT id FROM ai_model_providers'),
    db().query('SELECT id, provider_id, model_id FROM ai_provider_models'),
    db().query('SELECT id, provider_model_id FROM ai_model_pricing_rules'),
  ])
  const localProviderIds = new Set(providerRows[0].map((item) => String(item.id || '')))
  const addedProviders = remoteProviders.filter((item) => !localProviderIds.has(item.id))
  const addedModels = findMissingSyncItems(remoteModels, modelRows[0], modelSyncBusinessKey)
  const addedPricingRules = findMissingSyncItems(remotePricingRules, pricingRows[0], pricingSyncBusinessKey)
  const remoteModelById = new Map(remoteModels.map((item) => [item.id, item]))
  const scopes = {
    providers: {
      added: addedProviders.length,
      items: addedProviders.slice(0, 20).map((item) => ({ id: item.id, name: item.name || item.id })),
    },
    models: {
      added: addedModels.length,
      items: addedModels.slice(0, 20).map((item) => ({ id: item.id, name: item.displayName || item.modelId || item.id })),
    },
    pricingRules: {
      added: addedPricingRules.length,
      items: addedPricingRules.slice(0, 20).map((item) => {
        const model = remoteModelById.get(item.providerModelId)
        return { id: item.id, name: model?.displayName || model?.modelId || item.providerModelId || item.id }
      }),
    },
  }
  const signature = syncHash({
    providers: addedProviders.map((item) => item.id).sort(),
    models: addedModels.map((item) => item.id).sort(),
    pricingRules: addedPricingRules.map((item) => item.id).sort(),
  })
  return {
    updateAvailable: Object.values(scopes).some((item) => item.added > 0),
    checkedAt: nowIso(),
    signature,
    scopes,
  }
}

async function testBuildCenterConfig(input) {
  const existing = await getPlatformSettings('platform')
  const config = normalizeBuildCenterConfig({
    ...(input || {}),
    buildCenterToken: String(input?.buildCenterToken || '').trim() || existing.buildCenterToken,
  })
  if (!config.enabled) throw new Error('请填写完整的官方构建中心 URL、Supplier ID 和 Token')
  const workers = await buildCenterApi('/api/center/workers', { supplierId: config.supplierId }, config)
  const license = await buildCenterApi('/api/center/license', {
    supplierId: config.supplierId,
    projectIds: await listLocalSupplierProjectIds(),
  }, config).catch(() => null)
  return {
    ok: true,
    message: '官方构建中心连接成功，供应商凭据有效',
    workerCount: Array.isArray(workers) ? workers.length : 0,
    license,
    checkedAt: nowIso(),
  }
}

async function appendBuildLog(buildId, chunk) {
  const build = await findBuildById(buildId)
  if (!build) return null
  let nextLog = `${String(build.log || '')}${String(chunk || '')}`
  if (nextLog.length > 120000) nextLog = nextLog.slice(-120000)
  return updateBuild(buildId, { log: nextLog })
}

async function claimNextBuild(workerId) {
  if (!isManagedWorkerId(workerId)) return null
  const orphanMessage = '构建节点心跳中断，任务已自动结束，请点击重试重新提交构建'
  await db().query(
    `UPDATE ai_builds AS builds
     LEFT JOIN ai_workers AS workers ON workers.id = builds.claimed_by
     SET builds.status = 'failed',
         builds.error = ?,
         builds.finished_at = CURRENT_TIMESTAMP(3),
         builds.log = RIGHT(CONCAT(COALESCE(builds.log, ''), '[center] Worker heartbeat expired; build marked failed and can be retried\\n'), 120000)
     WHERE builds.status = 'running'
       AND builds.remote_build_id IS NULL
       AND COALESCE(builds.claimed_by, '') <> ''
       AND (
         workers.id IS NULL
         OR TIMESTAMPDIFF(SECOND, workers.last_seen_at, CURRENT_TIMESTAMP(3)) > 120
         OR COALESCE(workers.current_build_id, '') <> builds.id
       )`,
    [orphanMessage],
  )
  await touchWorker(workerId, { status: 'online', currentBuildId: '' })
  if (isWorkerDisabled(workerId, WORKER_DISABLED)) return null
  const worker = await findWorkerById(workerId)
  const workerVersion = String(worker?.metadata?.packageVersion || '').trim()
  if (!isDesktopNextVersion(workerVersion)) return null
  const preferredWorkerIds = higherPriorityWorkerIds(workerId, parseWorkerPriority(WORKER_PRIORITY))
  if (preferredWorkerIds.length > 0) {
    const placeholders = preferredWorkerIds.map(() => '?').join(', ')
    const [preferredWorkers] = await db().query(
      `SELECT ai_workers.*, TIMESTAMPDIFF(SECOND, last_seen_at, CURRENT_TIMESTAMP(3)) AS heartbeat_age_seconds
       FROM ai_workers
       WHERE id IN (${placeholders})`,
      preferredWorkerIds,
    )
    if (preferredWorkers.some((candidate) => isIdleCompatibleWorker(candidate, workerVersion))) return null
  }
  const [rows] = await db().query(
    `SELECT * FROM ai_builds
     WHERE status = 'queued' AND remote_build_id IS NULL AND version = ?
     ORDER BY created_at ASC
     LIMIT 1`,
    [workerVersion],
  )
  if (rows.length === 0) return null
  const build = normalizeBuild(rows[0])
  if (CENTER_SUPPLIER_MANAGEMENT_ENABLED) {
    await ensureWorkerStagingDirectory({ rootDir: PUBLIC_PREVIEW_ROOT, projectId: build.projectId })
  }
  const [result] = await db().query(
    `UPDATE ai_builds
     SET status = 'running', started_at = CURRENT_TIMESTAMP(3), claimed_by = ?, log = ?
     WHERE id = ? AND status = 'queued'`,
    [workerId, `[${nowIso()}] Claimed by ${workerId}\n`, build.id],
  )
  if (result.affectedRows !== 1) return null
  const next = await findBuildById(build.id)
  await touchWorker(workerId, { status: 'online', currentBuildId: build.id, claimed: true })
  return next
}

function buildArtifactUrl(baseUrl, fileName) {
  const base = String(baseUrl || '').replace(/\/$/, '')
  const encoded = encodeURIComponent(String(fileName || '')).replace(/%2F/g, '/')
  return `${base}/${encoded}`
}

function isBuildReleaseArtifact(name) {
  const fileName = String(name || '')
  return fileName === 'latest.yml' || fileName === 'latest.json' || fileName.endsWith('.exe') || fileName.endsWith('.blockmap')
}

function encodeOssObjectKey(key) {
  return String(key || '').split('/').map(encodeURIComponent).join('/')
}

function ossContentType(fileName) {
  const lower = String(fileName || '').toLowerCase()
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'text/yaml; charset=utf-8'
  return 'application/octet-stream'
}

function getOssArtifactConfig(settings) {
  const config = {
    accessKeyId: String(settings?.ossAccessKeyId || '').trim(),
    accessKeySecret: String(settings?.ossAccessKeySecret || '').trim(),
    bucket: String(settings?.ossBucket || '').trim(),
    endpoint: normalizeOssEndpoint(settings?.ossEndpoint || ''),
    publicBaseUrl: normalizeOssPublicBaseUrl({
      bucket: settings?.ossBucket,
      endpoint: settings?.ossEndpoint,
      publicBaseUrl: settings?.ossPublicBaseUrl,
    }),
    prefix: trimSlashes(settings?.ossPrefix || defaultPlatformSettings.ossPrefix),
  }
  config.enabled = Boolean(config.accessKeyId && config.accessKeySecret && config.bucket && config.endpoint && config.publicBaseUrl)
  return config
}

async function getProjectReleaseFeedUrl(projectId, publicUpdateBaseUrl = PUBLIC_UPDATE_BASE_URL) {
  const id = String(projectId || '').trim()
  const settings = await getPlatformSettings('platform')
  const ossConfig = getOssArtifactConfig(settings)
  if (settings.artifactStorageMode === 'oss' && ossConfig.enabled) {
    const objectPrefix = [ossConfig.prefix, 'ai', id].filter(Boolean).join('/')
    return `${ossConfig.publicBaseUrl.replace(/\/$/, '')}/${objectPrefix}/`
  }
  return `${publicUpdateBaseUrl.replace(/\/$/, '')}/${id}/`
}

async function applyProjectReleaseFeedUrl(brand, projectId, publicUpdateBaseUrl = PUBLIC_UPDATE_BASE_URL) {
  if (!brand) return brand
  brand.updateUrl = await getProjectReleaseFeedUrl(projectId || brand.sourceProjectId || brand.aiProjectId, publicUpdateBaseUrl)
  return brand
}

async function uploadFileToAliyunOss(config, filePath, objectKey, onProgress = null) {
  if (!config?.enabled) throw new Error('OSS 未配置完整')
  const name = path.basename(filePath)
  const contentType = ossContentType(name)
  const date = new Date().toUTCString()
  const resource = `/${config.bucket}/${objectKey}`
  const stringToSign = ['PUT', '', contentType, date, resource].join('\n')
  const signature = crypto.createHmac('sha1', config.accessKeySecret).update(stringToSign, 'utf-8').digest('base64')
  const url = `https://${config.bucket}.${config.endpoint}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
  const stat = await fsp.stat(filePath)
  const totalBytes = stat.size
  await new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'PUT',
      timeout: 15 * 60 * 1000,
      headers: {
        Date: date,
        'Content-Type': contentType,
        'Content-Length': totalBytes,
        Authorization: `OSS ${config.accessKeyId}:${signature}`,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve()
          return
        }
        reject(new Error(`OSS 上传失败：${name} HTTP ${response.statusCode}${body ? ` ${body.slice(0, 300)}` : ''}`))
      })
    })
    request.on('timeout', () => request.destroy(new Error(`OSS 上传超时：${name}`)))
    request.on('error', reject)
    const input = fs.createReadStream(filePath)
    let transferredBytes = 0
    let lastNotifiedAt = 0
    let lastPercent = -1
    input.on('data', (chunk) => {
      transferredBytes += chunk.length
      const percent = totalBytes > 0 ? Math.min(99, Math.floor((transferredBytes / totalBytes) * 100)) : 0
      const now = Date.now()
      if (onProgress && (now - lastNotifiedAt >= 1000 || percent - lastPercent >= 3)) {
        lastNotifiedAt = now
        lastPercent = percent
        Promise.resolve(onProgress({ fileName: name, transferredBytes, totalBytes, percent, done: false })).catch(() => {})
      }
    })
    input.on('error', (err) => request.destroy(err))
    input.on('end', () => {
      if (onProgress) Promise.resolve(onProgress({ fileName: name, transferredBytes, totalBytes, percent: 100, done: true })).catch(() => {})
    })
    input.pipe(request)
  })
}

async function copyAliyunOssObject(config, sourceKey, targetKey) {
  if (!config?.enabled) throw new Error('OSS 未配置完整')
  const date = new Date().toUTCString()
  const encodedSource = `/${config.bucket}/${encodeOssObjectKey(sourceKey)}`
  const resource = `/${config.bucket}/${targetKey}`
  const canonicalizedHeaders = `x-oss-copy-source:${encodedSource}\n`
  const stringToSign = ['PUT', '', '', date, `${canonicalizedHeaders}${resource}`].join('\n')
  const signature = crypto.createHmac('sha1', config.accessKeySecret).update(stringToSign, 'utf-8').digest('base64')
  const url = `https://${config.bucket}.${config.endpoint}/${encodeOssObjectKey(targetKey)}`
  await new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'PUT',
      timeout: 5 * 60 * 1000,
      headers: {
        Date: date,
        'Content-Length': 0,
        'x-oss-copy-source': encodedSource,
        Authorization: `OSS ${config.accessKeyId}:${signature}`,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve()
          return
        }
        reject(new Error(`OSS 服务端复制失败：HTTP ${response.statusCode}${body ? ` ${body.slice(0, 300)}` : ''}`))
      })
    })
    request.on('timeout', () => request.destroy(new Error('OSS 服务端复制超时')))
    request.on('error', reject)
    request.end()
  })
}

function ossObjectKeyFromPublicUrl(config, publicUrl, fileName) {
  const base = String(config?.publicBaseUrl || '').replace(/\/$/, '')
  const url = buildArtifactUrl(publicUrl, fileName)
  if (!base || !url.startsWith(`${base}/`)) return ''
  try {
    const parsed = new URL(url)
    return decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  } catch {
    return ''
  }
}

async function verifyPublicArtifactUrl(publicUrl, label = '公开访问') {
  const latestUrl = buildArtifactUrl(publicUrl, 'latest.yml')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15 * 1000)
  try {
    let response = await fetch(latestUrl, { method: 'HEAD', signal: controller.signal })
    if (!response.ok && response.status !== 405) {
      throw new Error(`HTTP ${response.status}`)
    }
    if (response.status === 405) {
      response = await fetch(latestUrl, { headers: { Range: 'bytes=0-0' }, signal: controller.signal })
      if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`${label}校验失败：${message}。请确认正式包更新地址可公开访问，并且 latest.yml 可以下载。`)
  } finally {
    clearTimeout(timer)
  }
}

function updateFeedUrlFromBuild(build) {
  const configured = normalizeHttpUrl(build?.brand?.updateUrl || '')
  if (configured) return `${configured.replace(/\/+$/, '')}/`
  return `${PUBLIC_UPDATE_BASE_URL.replace(/\/$/, '')}/${build.projectId}/`
}

function releasePathSegmentsFromUrl(releaseUrl, fallbackProjectId) {
  try {
    const parsed = new URL(normalizeHttpUrl(releaseUrl))
    const updatePath = publicPathFromBaseUrl(PUBLIC_UPDATE_BASE_URL).replace(/\/+$/, '')
    const targetPath = decodeURIComponent(parsed.pathname).replace(/\/+$/, '')
    if (updatePath && updatePath !== '/' && (targetPath === updatePath || targetPath.startsWith(`${updatePath}/`))) {
      const relative = targetPath.slice(updatePath.length).replace(/^\/+/, '')
      if (relative) {
        const parts = relative.split('/').filter(Boolean)
        if (parts.length > 0 && parts.every((part) => part === path.basename(part) && part !== '.' && part !== '..')) {
          return parts
        }
      }
    }
  } catch {
    // Fall back to the build project id below.
  }
  return [fallbackProjectId]
}

function localReleaseLocationForBuild(build) {
  const releaseUrl = updateFeedUrlFromBuild(build)
  return {
    releaseUrl,
    targetDir: path.join(PUBLIC_UPDATE_ROOT, ...releasePathSegmentsFromUrl(releaseUrl, build.projectId)),
  }
}

async function uploadBuildDirToOss(config, sourceDir, projectId, files, channel, onProgress = null) {
  const objectPrefix = [config.prefix, channel, projectId].filter(Boolean).join('/')
  const totalFiles = files.length || 1
  for (const [index, file] of files.entries()) {
    const name = path.basename(String(file))
    if (onProgress) await onProgress({
      status: 'uploading',
      fileName: name,
      currentFileIndex: index + 1,
      totalFiles,
      percent: Math.floor((index / totalFiles) * 100),
    })
    await uploadFileToAliyunOss(config, path.join(sourceDir, name), `${objectPrefix}/${name}`, (progress) => {
      const filePercent = Number(progress.percent || 0)
      const overallPercent = Math.max(0, Math.min(100, Math.floor(((index + filePercent / 100) / totalFiles) * 100)))
      if (onProgress) return onProgress({
        status: 'uploading',
        fileName: name,
        currentFileIndex: index + 1,
        totalFiles,
        percent: overallPercent,
        currentFilePercent: filePercent,
        transferredBytes: Number(progress.transferredBytes || 0),
        totalBytes: Number(progress.totalBytes || 0),
      })
      return null
    })
    if (onProgress) await onProgress({
      status: 'uploaded',
      fileName: name,
      currentFileIndex: index + 1,
      totalFiles,
      percent: Math.floor(((index + 1) / totalFiles) * 100),
    })
  }
  const publicUrl = `${config.publicBaseUrl.replace(/\/$/, '')}/${objectPrefix}/`
  if (onProgress) await onProgress({ status: 'verifying', fileName: 'latest.yml', currentFileIndex: totalFiles, totalFiles, percent: 100 })
  await verifyPublicArtifactUrl(publicUrl, 'OSS 公开访问')
  return publicUrl
}

async function copyBuildObjectsWithinOss(config, build, files, channel, onProgress = null) {
  if (!config?.enabled) throw new Error('OSS 未配置完整')
  const objectPrefix = [config.prefix, channel, build.projectId].filter(Boolean).join('/')
  const names = files.map((file) => path.basename(String(file))).filter(Boolean)
  const sources = names.map((name) => ({ name, sourceKey: ossObjectKeyFromPublicUrl(config, build.publicUrl, name) }))
  if (sources.some((item) => !item.sourceKey)) throw new Error('测试包不在当前代理 OSS 中，无法服务端复制')
  const totalFiles = sources.length || 1
  for (const [index, item] of sources.entries()) {
    if (onProgress) await onProgress({
      status: 'copying',
      fileName: item.name,
      currentFileIndex: index + 1,
      totalFiles,
      percent: Math.floor((index / totalFiles) * 100),
    })
    await copyAliyunOssObject(config, item.sourceKey, `${objectPrefix}/${item.name}`)
    if (onProgress) await onProgress({
      status: 'copied',
      fileName: item.name,
      currentFileIndex: index + 1,
      totalFiles,
      percent: Math.floor(((index + 1) / totalFiles) * 100),
    })
  }
  const publicUrl = `${config.publicBaseUrl.replace(/\/$/, '')}/${objectPrefix}/`
  if (onProgress) await onProgress({ status: 'verifying', fileName: 'latest.yml', currentFileIndex: totalFiles, totalFiles, percent: 100 })
  await verifyPublicArtifactUrl(publicUrl, 'OSS 公开访问')
  return publicUrl
}

async function copyOrDownloadBuildFile(build, name, targetDir, onProgress = null) {
  const localPath = build.artifactDir ? path.join(build.artifactDir, name) : ''
  const targetPath = path.join(targetDir, name)
  if (localPath) {
    try {
      await fsp.copyFile(localPath, targetPath)
      if (onProgress) await onProgress({ fileName: name, transferredBytes: 1, totalBytes: 1, percent: 100, done: true })
      return
    } catch (err) {
      if (!build.publicUrl) throw err
    }
  }
  if (!build.publicUrl) throw new Error(`构建产物不存在：${name}`)
  const url = buildArtifactUrl(build.publicUrl, name)
  await downloadBuildArtifact({ url, targetPath, fileName: name, onProgress })
}

async function canAccessBuildFile(build, name) {
  const localPath = build.artifactDir ? path.join(build.artifactDir, name) : ''
  if (localPath) {
    try {
      await fsp.access(localPath)
      return true
    } catch {}
  }
  if (!build.publicUrl) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15 * 1000)
  try {
    const response = await fetch(buildArtifactUrl(build.publicUrl, name), { method: 'HEAD', signal: controller.signal })
    if (response.ok) return true
    if (response.status === 405 || response.status === 403) {
      const fallback = await fetch(buildArtifactUrl(build.publicUrl, name), { signal: controller.signal })
      return fallback.ok
    }
    return false
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function assertBuildArtifactsAvailable(build) {
  const files = Array.isArray(build.files) ? build.files.map((file) => path.basename(String(file))) : []
  const required = files.filter(isBuildReleaseArtifact)
  if (!required.includes('latest.yml') || !required.some((name) => name.endsWith('.exe'))) {
    throw new Error('测试包产物记录不完整，请重新打包测试版后再推送给用户')
  }
  for (const name of required.filter((file) => file === 'latest.yml' || file.endsWith('.exe'))) {
    if (!(await canAccessBuildFile(build, name))) {
      throw new Error(`测试包文件已被清理或无法访问（缺少 ${name}），请重新打包测试版后再推送给用户`)
    }
  }
}

async function cleanupStalePackageFiles(targetDir, keepNames, buildId, label) {
  const keep = new Set(Array.from(keepNames || []).map((name) => path.basename(String(name))))
  let removed = 0
  let entries = []
  try {
    entries = await fsp.readdir(targetDir, { withFileTypes: true })
  } catch {
    return { removed }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (keep.has(name)) continue
    if (!name.endsWith('.exe') && !name.endsWith('.blockmap')) continue
    await fsp.rm(path.join(targetDir, name), { force: true })
    removed += 1
  }
  if (removed > 0 && buildId) {
    await appendBuildLog(buildId, `[admin] 已清理${label || '目录'}旧安装包 ${removed} 个。\n`).catch(() => {})
  }
  return { removed }
}

async function stageRemoteBuildArtifacts(localBuild, remoteBuild) {
  const settings = await getPlatformSettings('platform')
  const ossConfig = getOssArtifactConfig(settings)
  const useOss = settings.artifactStorageMode === 'oss'
  if (useOss && !ossConfig.enabled) throw new Error('已选择 OSS 托管，但 OSS 配置不完整')
  const targetDir = useOss
    ? path.join(repoRoot, 'data', 'artifact-staging', localBuild.id)
    : path.join(PUBLIC_PREVIEW_ROOT, localBuild.projectId)
  await fsp.mkdir(targetDir, { recursive: true })
  const copied = []
  const remoteFiles = Array.isArray(remoteBuild.files) ? remoteBuild.files : []
  const candidateFiles = remoteFiles
    .map((file) => path.basename(String(file)))
    .filter(isBuildReleaseArtifact)
  const source = {
    artifactDir: '',
    publicUrl: remoteBuild.publicUrl || '',
  }
  const totalFiles = candidateFiles.length || 1
  const updateTransferProgress = async (index, progress) => {
    const currentPercent = Number(progress.percent || 0)
    const overallPercent = Math.max(0, Math.min(100, Math.floor(((index + currentPercent / 100) / totalFiles) * 100)))
    await updateBuild(localBuild.id, {
      transferProgress: {
        phase: 'staging',
        status: progress.done ? 'file-complete' : 'transferring',
        currentFile: progress.fileName || '',
        currentFileIndex: index + 1,
        totalFiles,
        currentFilePercent: progress.done ? 100 : currentPercent,
        overallPercent,
        transferredBytes: Number(progress.transferredBytes || 0),
        totalBytes: Number(progress.totalBytes || 0),
        updatedAt: nowIso(),
      },
    }).catch(() => {})
  }
  for (const [index, name] of candidateFiles.entries()) {
    await copyOrDownloadBuildFile(source, name, targetDir, (progress) => updateTransferProgress(index, progress))
    copied.push(name)
  }
  if (!copied.includes('latest.yml') || !copied.some((name) => name.endsWith('.exe'))) {
    throw new Error('官方测试包产物不完整')
  }
  await normalizeLatestYmlFileUrls(targetDir)
  await cleanupStalePackageFiles(targetDir, copied, localBuild.id, '测试包')
  if (useOss) {
    await updateBuild(localBuild.id, {
      transferProgress: {
        phase: 'staging',
        status: 'uploading',
        currentFile: '正在上传到代理 OSS',
        currentFileIndex: totalFiles,
        totalFiles,
        currentFilePercent: 100,
        overallPercent: 100,
        transferredBytes: 0,
        totalBytes: 0,
        updatedAt: nowIso(),
      },
    }).catch(() => {})
  }
  const publicUrl = useOss
    ? await uploadBuildDirToOss(ossConfig, targetDir, localBuild.projectId, copied, 'ai-staging', (progress) => updateBuild(localBuild.id, {
        transferProgress: {
          phase: 'staging',
          status: progress.status || 'uploading',
          currentFile: progress.status === 'verifying' ? '正在校验代理 OSS 公开访问' : `上传到代理 OSS：${progress.fileName || ''}`,
          currentFileIndex: progress.currentFileIndex || totalFiles,
          totalFiles: progress.totalFiles || totalFiles,
          currentFilePercent: Number(progress.currentFilePercent ?? progress.percent ?? 0),
          overallPercent: Number(progress.percent || 0),
          transferredBytes: Number(progress.transferredBytes || 0),
          totalBytes: Number(progress.totalBytes || 0),
          updatedAt: nowIso(),
        },
      }).catch(() => {}))
    : `${PUBLIC_PREVIEW_BASE_URL.replace(/\/$/, '')}/${localBuild.projectId}/`
  if (useOss) {
    await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {})
  }
  const log = `${remoteBuild.log || localBuild.log || ''}[admin] 官方测试包已同步到供应商本地：${publicUrl}\n`
  await updateBuild(localBuild.id, {
    transferProgress: {
      phase: 'staging',
      status: 'completed',
      currentFile: '',
      currentFileIndex: totalFiles,
      totalFiles,
      currentFilePercent: 100,
      overallPercent: 100,
      transferredBytes: 0,
      totalBytes: 0,
      updatedAt: nowIso(),
    },
  }).catch(() => {})
  return { artifactDir: useOss ? '' : targetDir, publicUrl, files: copied, log }
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function cleanupBuildArtifacts(build) {
  const artifactDir = String(build?.artifactDir || '')
  if (!artifactDir) return { removed: false, reason: 'no-artifact-dir' }
  if (!isPathInside(PUBLIC_PREVIEW_ROOT, artifactDir)) {
    throw new Error('构建产物目录不在测试包目录内，拒绝删除')
  }
  await fsp.rm(artifactDir, { recursive: true, force: true })
  await appendBuildLog(build.id, `[center] 测试包临时文件已清理：${artifactDir}\n`).catch(() => {})
  await updateBuild(build.id, { artifactDir: '', publicUrl: '' })
  return { removed: true, artifactDir }
}

function latestYmlRelativeFileName(value) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '')
  if (!raw) return raw
  try {
    if (/^https?:\/\//i.test(raw)) {
      return decodeURIComponent(path.basename(new URL(raw).pathname))
    }
  } catch {
    return path.basename(raw)
  }
  return path.basename(raw)
}

async function normalizeLatestYmlFileUrls(targetDir) {
  const latestPath = path.join(targetDir, 'latest.yml')
  let text = await fsp.readFile(latestPath, 'utf-8').catch(() => '')
  if (!text) return
  text = text.replace(/^(\s*(?:-\s*)?url:\s*)(.+?\.exe)(\s*)$/gmi, (_match, prefix, value, suffix) => `${prefix}${latestYmlRelativeFileName(value)}${suffix}`)
  text = text.replace(/^(\s*path:\s*)(.+?\.exe)(\s*)$/gmi, (_match, prefix, value, suffix) => `${prefix}${latestYmlRelativeFileName(value)}${suffix}`)
  await fsp.writeFile(latestPath, text, 'utf-8')
}

function uniquePaths(paths) {
  const seen = new Set()
  return paths.filter((item) => {
    const resolved = path.resolve(item)
    if (seen.has(resolved)) return false
    seen.add(resolved)
    return true
  })
}

function extraReleaseRoots() {
  const roots = []
  const updatePath = publicPathFromBaseUrl(PUBLIC_UPDATE_BASE_URL)
  if (updatePath === '/updates/ai') {
    roots.push(path.join(path.dirname(repoRoot), 'updates', 'ai'))
  }
  return uniquePaths(roots).filter((root) => path.resolve(root) !== path.resolve(PUBLIC_UPDATE_ROOT))
}

async function pathInfo(target) {
  const stat = await fsp.stat(target).catch(() => null)
  return {
    path: target,
    exists: Boolean(stat),
    type: stat?.isDirectory() ? 'directory' : (stat?.isFile() ? 'file' : ''),
  }
}

async function diagnosticsInfo() {
  const releaseRoots = uniquePaths([PUBLIC_UPDATE_ROOT, ...extraReleaseRoots()])
  const previewRoots = uniquePaths([PUBLIC_PREVIEW_ROOT])
  const latestBuilds = (await listBuildsForUser({ role: 'admin' })).slice(0, 8).map((build) => ({
    id: build.id,
    projectId: build.projectId,
    version: build.version,
    status: build.status,
    releaseStatus: build.releaseStatus,
    publicUrl: build.publicUrl,
    releaseUrl: build.releaseUrl,
    releaseError: build.releaseError,
    updatedAt: build.updatedAt,
  }))
  const releasedBuilds = latestBuilds.filter((build) => build.releaseUrl).slice(0, 5)
  const apiCheckUrl = `${PUBLIC_ADMIN_BASE_URL.replace(/\/$/, '')}/api/me`
  const updateCheckExampleUrl = `${PUBLIC_UPDATE_BASE_URL.replace(/\/$/, '')}/<项目ID>/latest.yml`
  const clientRegisterUrl = `${PUBLIC_ADMIN_BASE_URL.replace(/\/$/, '')}/api/client/auth/register`
  const protocolFallback = {
    publicAdminBaseUrl: alternateHttpProtocolUrl(PUBLIC_ADMIN_BASE_URL),
    publicUpdateBaseUrl: alternateHttpProtocolUrl(PUBLIC_UPDATE_BASE_URL),
    apiCheckUrl: alternateHttpProtocolUrl(apiCheckUrl),
    updateCheckExampleUrl: alternateHttpProtocolUrl(updateCheckExampleUrl),
    clientRegisterUrl: alternateHttpProtocolUrl(clientRegisterUrl),
  }
  return {
    generatedAt: nowIso(),
    version: process.env.npm_package_version || PACKAGE_VERSION,
    node: process.version,
    pm2Name: SELF_UPDATE_PM2_NAME,
    listen: `http://${HOST}:${PORT}`,
    publicAdminBaseUrl: PUBLIC_ADMIN_BASE_URL,
    publicUpdateBaseUrl: PUBLIC_UPDATE_BASE_URL,
    publicPreviewBaseUrl: PUBLIC_PREVIEW_BASE_URL,
    apiCheckUrl,
    updateCheckExampleUrl,
    clientRegisterUrl,
    protocolFallback,
    updateCheckUrls: releasedBuilds.map((build) => ({
      projectId: build.projectId,
      latestUrl: `${build.releaseUrl.replace(/\/$/, '')}/latest.yml`,
      fallbackLatestUrl: alternateHttpProtocolUrl(`${build.releaseUrl.replace(/\/$/, '')}/latest.yml`),
    })),
    updateRoots: await Promise.all(releaseRoots.map(pathInfo)),
    previewRoots: await Promise.all(previewRoots.map(pathInfo)),
    recentBuilds: latestBuilds,
    appLogTail: await tailTextFile(APP_LOG_FILE),
    selfUpdateLogTail: await tailTextFile(path.join(SELF_UPDATE_WORK_DIR, 'update.log')),
  }
}

async function releaseBuild(build, user) {
  const project = await findProjectById(build.projectId)
  if (!project || !canAccessProject(user, project)) {
    throw new Error('构建任务不存在或无权发布')
  }
  if (!canOperateProject(user, project)) {
    throw new Error('只能发布自己名下项目的构建任务')
  }
  if (build.status !== 'succeeded') throw new Error('只有已完成的构建可以发布')
  if ((!build.artifactDir && !build.publicUrl) || !Array.isArray(build.files) || build.files.length === 0) {
    throw new Error('构建产物不存在，无法发布')
  }
  await assertBuildArtifactsAvailable(build)

  const settings = await getPlatformSettings('platform')
  const ossConfig = getOssArtifactConfig(settings)
  const useOss = settings.artifactStorageMode === 'oss'
  if (useOss && !ossConfig.enabled) throw new Error('已选择 OSS 托管，但 OSS 配置不完整')

  const candidateFiles = build.files
    .map((file) => path.basename(String(file)))
    .filter(isBuildReleaseArtifact)
  if (useOss && build.publicUrl && candidateFiles.length > 0) {
    try {
      await updateBuild(build.id, {
        transferProgress: {
          phase: 'release',
          status: 'copying',
          currentFile: '正在通过 OSS 服务端复制正式包',
          currentFileIndex: 0,
          totalFiles: candidateFiles.length,
          currentFilePercent: 0,
          overallPercent: 0,
          transferredBytes: 0,
          totalBytes: 0,
          updatedAt: nowIso(),
        },
      }).catch(() => {})
      const releaseUrl = await copyBuildObjectsWithinOss(ossConfig, build, candidateFiles, 'ai', (progress) => updateBuild(build.id, {
        transferProgress: {
          phase: 'release',
          status: progress.status || 'copying',
          currentFile: progress.status === 'verifying' ? '正在校验正式包公开访问' : `OSS 服务端复制：${progress.fileName || ''}`,
          currentFileIndex: progress.currentFileIndex || 0,
          totalFiles: progress.totalFiles || candidateFiles.length,
          currentFilePercent: 100,
          overallPercent: Number(progress.percent || 0),
          transferredBytes: 0,
          totalBytes: 0,
          updatedAt: nowIso(),
        },
      }).catch(() => {}))
      const next = await updateBuild(build.id, {
        releaseUrl,
        releasedAt: nowIso(),
        transferProgress: {
          phase: 'release',
          status: 'completed',
          currentFile: '',
          currentFileIndex: candidateFiles.length,
          totalFiles: candidateFiles.length,
          currentFilePercent: 100,
          overallPercent: 100,
          transferredBytes: 0,
          totalBytes: 0,
          updatedAt: nowIso(),
        },
      })
      await appendBuildLog(build.id, `[admin] Released by ${user.username} to ${releaseUrl} via OSS server-side copy.\n`)
      return { ...next, releaseUrl, releasedAt: next.releasedAt || nowIso() }
    } catch (err) {
      await appendBuildLog(build.id, `[admin] OSS server-side release copy unavailable, fallback to local transfer: ${err instanceof Error ? err.message : String(err)}\n`).catch(() => {})
    }
  }

  const localRelease = localReleaseLocationForBuild(build)
  const targetDir = useOss
    ? path.join(repoRoot, 'data', 'artifact-release', build.id)
    : localRelease.targetDir
  await fsp.mkdir(targetDir, { recursive: true })
  const copied = []
  const totalFiles = candidateFiles.length || 1
  const updateReleaseProgress = async (phase, index, progress) => updateBuild(build.id, {
    transferProgress: {
      phase: 'release',
      status: phase,
      currentFile: `${phase === 'uploading' ? '上传正式包到代理 OSS' : '准备正式包'}：${progress.fileName || ''}`,
      currentFileIndex: index + 1,
      totalFiles,
      currentFilePercent: Number(progress.currentFilePercent ?? progress.percent ?? 0),
      overallPercent: Math.max(0, Math.min(100, Math.floor(((index + Number(progress.percent || 0) / 100) / totalFiles) * 100))),
      transferredBytes: Number(progress.transferredBytes || 0),
      totalBytes: Number(progress.totalBytes || 0),
      updatedAt: nowIso(),
    },
  }).catch(() => {})
  for (const [index, name] of candidateFiles.entries()) {
    await copyOrDownloadBuildFile(build, name, targetDir)
    await updateReleaseProgress('preparing', index, { fileName: name, percent: 100, currentFilePercent: 100 })
    copied.push(name)
  }
  if (!copied.includes('latest.yml') || !copied.some((name) => name.endsWith('.exe'))) {
    throw new Error('发布产物不完整')
  }
  await normalizeLatestYmlFileUrls(targetDir)
  await cleanupStalePackageFiles(targetDir, copied, build.id, '正式包')

  const mirroredRoots = []
  if (!useOss) for (const root of extraReleaseRoots()) {
    const mirrorDir = path.join(root, build.projectId)
    try {
      await fsp.mkdir(mirrorDir, { recursive: true })
      for (const name of copied) {
        await fsp.copyFile(path.join(targetDir, name), path.join(mirrorDir, name))
      }
      await cleanupStalePackageFiles(mirrorDir, copied, build.id, '正式包镜像')
      mirroredRoots.push(mirrorDir)
    } catch (err) {
      await appendBuildLog(build.id, `[admin] Release mirror failed: ${mirrorDir} - ${err instanceof Error ? err.message : String(err)}\n`).catch(() => {})
    }
  }

  const releaseUrl = useOss
    ? await uploadBuildDirToOss(ossConfig, targetDir, build.projectId, copied, 'ai', (progress) => updateBuild(build.id, {
        transferProgress: {
          phase: 'release',
          status: progress.status || 'uploading',
          currentFile: progress.status === 'verifying' ? '正在校验正式包公开访问' : `上传正式包到代理 OSS：${progress.fileName || ''}`,
          currentFileIndex: progress.currentFileIndex || totalFiles,
          totalFiles: progress.totalFiles || totalFiles,
          currentFilePercent: Number(progress.currentFilePercent ?? progress.percent ?? 0),
          overallPercent: Number(progress.percent || 0),
          transferredBytes: Number(progress.transferredBytes || 0),
          totalBytes: Number(progress.totalBytes || 0),
          updatedAt: nowIso(),
        },
      }).catch(() => {}))
    : localRelease.releaseUrl
  if (!useOss) {
    await updateBuild(build.id, {
      transferProgress: {
        phase: 'release',
        status: 'verifying',
        currentFile: '正在校验正式包公开访问',
        currentFileIndex: totalFiles,
        totalFiles,
        currentFilePercent: 100,
        overallPercent: 100,
        transferredBytes: 0,
        totalBytes: 0,
        updatedAt: nowIso(),
      },
    }).catch(() => {})
    await verifyPublicArtifactUrl(releaseUrl, '正式包公开访问')
  }
  if (useOss) {
    await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {})
  }
  const next = await updateBuild(build.id, {
    releaseUrl,
    releasedAt: nowIso(),
    transferProgress: {
      phase: 'release',
      status: 'completed',
      currentFile: '',
      currentFileIndex: totalFiles,
      totalFiles,
      currentFilePercent: 100,
      overallPercent: 100,
      transferredBytes: 0,
      totalBytes: 0,
      updatedAt: nowIso(),
    },
  })
  await appendBuildLog(build.id, `[admin] Released by ${user.username} to ${releaseUrl}${mirroredRoots.length ? `; mirrored to ${mirroredRoots.join(', ')}` : ''}\n`)
  return { ...next, releaseUrl, releasedAt: next.releasedAt || nowIso() }
}

async function startReleaseBuild(build, user) {
  if (build.centerSupplierId) {
    throw new Error('供应商代构建任务应由发起方后台推送给其用户')
  }
  const project = await findProjectById(build.projectId)
  if (!project || !canAccessProject(user, project)) {
    throw new Error('构建任务不存在或无权发布')
  }
  if (!canOperateProject(user, project)) {
    throw new Error('只能发布自己名下项目的构建任务')
  }
  if (build.status !== 'succeeded') throw new Error('只有已完成的构建可以发布')
  if (build.releasedAt) return build
  if (build.releaseStatus === 'publishing') return build

  const started = await updateBuild(build.id, {
    releaseStatus: 'publishing',
    releaseError: '',
  })
  await appendBuildLog(build.id, `[admin] Publishing started by ${user.username}. Artifacts will be copied to the release channel in background.\n`)

  setImmediate(async () => {
    try {
      const latest = await findBuildById(build.id)
      const released = await releaseBuild(latest, user)
      await updateBuild(released.id, {
        releaseStatus: '',
        releaseError: '',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await updateBuild(build.id, {
        releaseStatus: 'failed',
        releaseError: message,
      }).catch(() => {})
      await appendBuildLog(build.id, `[admin] Publishing failed: ${message}\n`).catch(() => {})
    }
  })

  return started
}

const ADMIN_ASSET_VERSION = [
  PACKAGE_VERSION,
  crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(path.dirname(WEB_INDEX_PATH), 'styles', 'admin.css')))
    .update(fs.readFileSync(path.join(path.dirname(WEB_INDEX_PATH), 'js', 'admin.js')))
    .update(fs.readFileSync(path.join(path.dirname(WEB_INDEX_PATH), 'js', 'views', 'organizations.js')))
    .digest('hex')
    .slice(0, 12),
].join('-')

const ADMIN_HTML = fs.readFileSync(WEB_INDEX_PATH, 'utf8')
  .replace(
    "${CENTER_SUPPLIER_MANAGEMENT_ENABLED ? 'true' : 'false'}",
    CENTER_SUPPLIER_MANAGEMENT_ENABLED ? 'true' : 'false',
  )
  .replaceAll('__ADMIN_ASSET_VERSION__', encodeURIComponent(ADMIN_ASSET_VERSION))
const ADMIN_V2_HTML = fs.readFileSync(ADMIN_V2_INDEX_PATH, 'utf8')
const SITE_HTML = fs.readFileSync(SITE_INDEX_PATH, 'utf8')
const RUNTIME_INFO = Object.freeze({
  version: PACKAGE_VERSION,
  startedAt: new Date().toISOString(),
  instanceId: crypto.randomBytes(8).toString('hex'),
})

registerAuthRoutes(app, {
  ADMIN_HTML,
  ADMIN_V2_HTML,
  SITE_HTML,
  renderSiteHtml: () => customHomepage.isEnabled() ? customHomepage.renderShell() : SITE_HTML,
  runtimeInfo: RUNTIME_INFO,
  sessions,
  getPlatformSettings,
  findUserByUsername,
  sanitizeUser,
  getUserBySession,
  getEffectivePermissionKeys,
  enrichUserContext,
  loginProtection,
})

registerOrganizationRoutes(app, {
  centralized: Boolean(authorizationClient),
  repository: organizationRepository,
  getSupplierLicense,
  ensureAccountFreeMembership,
  permissionByKey,
  revokeUserSessions(userId) {
    for (const [token, session] of sessions.entries()) {
      if (session.userId === userId) sessions.delete(token)
    }
  },
})

const commerceRuntime = agentCommerceRuntime({ client: authorizationClient, database: db })
const resourcesRuntime = resourceRuntime({ client: authorizationClient, database: db, resolveOrganization: organizationRepository.findOrganizationById, readBuild: findBuildById })
registerDeploymentAuthorizationRoutes(app, { client: authorizationClient, repository: organizationRepository, database: db, ensureAccountFreeMembership, monitor: commerceRuntime?.monitor })
registerAgentSupplyRoutes(app, { runtime: commerceRuntime, client: authorizationClient, repository: organizationRepository,
  resolveUserContext: async user => {
    const billingOwnerUserId = await keyOwnerUserIdForEndUser(user.id)
    const resolved = await organizationRepository.findOrganizationContextForUser(billingOwnerUserId)
    if (!resolved) throw new Error('终端用户没有有效的组织归属')
    const allowed = await allowedProviderModelIdSetForUser(user.id)
    return { ...resolved.organization, billingOwnerUserId, organizationLevel: resolved.organization.agentLevel, organizationId: resolved.organization.id,
      ...(allowed ? { allowedModelIds: [...allowed] } : {}) }
  },
})

registerClientProjectPolicyRoutes(app)
registerClientApiRoutes(app, {
  registerEndUser,
  requestEndUserRegistrationCode,
  loginEndUser,
  sanitizeEndUser,
  findEndUserById,
  findEndUserWithMembershipById,
  changeEndUserPassword,
  requestEndUserPasswordReset,
  confirmEndUserPasswordReset,
  keyOwnerUserIdForEndUser,
  listCreditLedger,
  listCreditLedgerPage,
  listClientModelCatalog,
  resolveModelProxyContext,
  generateImageForClient,
  recordModelKeySuccess,
  recordModelKeyFailure,
  recordModelKeyUsageFailure,
  deductCreditsForLocalUsage,
  getClientCreditState,
  assertClientModelRequestAllowed,
  loginProtection,
})
registerClientNoticeRoutes(app)

registerSystemRoutes(app, {
  getEffectivePermissionKeys,
  getSourceVersionInfo: getVisibleSourceVersionInfo,
  getSelfUpdateStatus,
  saveSelfUpdateManifestUrl,
  applySelfUpdate,
  getPlatformSettings,
  getPlatformSettingsForDisplay,
  sanitizePlatformSettings,
  savePlatformSettings,
  sendSmtpTestEmail,
  testBuildCenterConfig,
  getSupplierLicense,
  resetSupplierLicenseCache,
  listRoleTemplates,
  upsertRoleTemplate,
  saveRoleTemplatePermissions,
  deleteRoleTemplate,
  getUserPermissionPreview,
})
registerCustomHomepageRoutes(app, { service: customHomepage })

registerRedeemCodeRoutes(app)
registerMembershipRoutes(app, {
  assertCanAccessEndUser: assertCanOperateEndUser,
})
registerPaymentRoutes(app, {
  keyOwnerUserIdForEndUser,
})
const curatedSkillSync = registerCuratedSkillRoutes(app, {
  keyOwnerUserIdForEndUser,
  centerMode: CENTER_SUPPLIER_MANAGEMENT_ENABLED,
  fetchCenterCatalog: () => buildCenterApi('/api/center/curated-skills/catalog'),
  fetchCenterPackage: (skillId, version) => buildCenterBinary(`/api/center/curated-skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/package`),
  fetchCenterLease: (skillId, version, body, grantId) => buildCenterApi(`/api/center/curated-skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/lease`, body, null, grantId),
  reportCenterSync: (body) => buildCenterApi('/api/center/curated-skills/sync-report', body),
})
const curatedMcpSync = registerCuratedMcpRoutes(app, {
  keyOwnerUserIdForEndUser,
  centerMode: CENTER_SUPPLIER_MANAGEMENT_ENABLED,
  fetchCenterCatalog: () => buildCenterApi('/api/center/curated-mcps/catalog'),
  reportCenterSync: (body) => buildCenterApi('/api/center/curated-mcps/sync-report', body),
})
const curatedAgentSync = registerCuratedAgentRoutes(app, {
  keyOwnerUserIdForEndUser,
  centerMode: CENTER_SUPPLIER_MANAGEMENT_ENABLED,
  fetchCenterCatalog: () => buildCenterApi('/api/center/curated-agents/catalog'),
  reportCenterSync: (body) => buildCenterApi('/api/center/curated-agents/sync-report', body),
})
startMarketAutoSync({
  tasks: [
    { name: 'curated-skills', run: () => curatedSkillSync.syncCenterSkills('admin') },
    { name: 'curated-mcps', run: () => curatedMcpSync.syncCenterMcps() },
    { name: 'curated-agents', run: () => curatedAgentSync.syncCenterAgents() },
  ],
  logger: { log: (message) => writeAppLog('market-sync', message), error: (message) => writeAppLog('market-sync', `ERROR ${message}`) },
})
if (!CENTER_SUPPLIER_MANAGEMENT_ENABLED) {
  startMarketAutoSync({
    tasks: [{ name: 'client-notices', run: async () => {
      const config = await getBuildCenterConfig()
      return syncNoticesFromCenter((path, body) => buildCenterApi(path, body, config), config.supplierId)
    } }],
    intervalMs: 2 * 60 * 1000,
    initialDelayMs: 10 * 1000,
    logger: { log: (message) => writeAppLog('notice-sync', message), error: (message) => writeAppLog('notice-sync', `ERROR ${message}`) },
  })
}
registerModelServiceRoutes(app, {
  listModelProviders,
  saveModelProvider,
  findModelProviderById,
  enableModelProvider,
  getModelServiceUpdateStatus,
  syncModelServiceFromCenter,
  listModelProviderKeys,
  saveModelProviderKey,
  normalizeModelProviderKey,
  listModelProviderKeyUsage,
  listProviderModels,
  saveProviderModel,
  enableProviderModel,
  findProviderModelById,
  testProviderModelConnectivity,
  normalizeProviderModel,
  listModelPricingRules,
  saveModelPricingRule,
  enableModelPricingRule,
  findModelPricingRuleById,
  normalizeModelPricingRule,
  getPlatformSettings,
  previewSecret,
})

// Resolve the shared pool lazily because routes are assembled before database startup.
const voicePool = {
  query: (...args) => db().query(...args),
  getConnection: (...args) => db().getConnection(...args),
}
registerUpstreamAccountRoutes(app, new UpstreamAccountService(voicePool))
const voiceCredentialVault = new ModelCredentialVault(MODEL_CREDENTIAL_KEY_PATH)
const voiceOperations = new VoiceOperationRepository(voicePool)
const pricingPlanRepository = new PricingPlanRepository(voicePool)
const voiceContexts = new VoiceModelContext({ pool: voicePool, vault: voiceCredentialVault, allowedModels: allowedProviderModelIdSetForUser, pricingPlans: pricingPlanRepository })
const voiceArtifacts = new VoiceArtifactStore(VOICE_ARTIFACT_ROOT)
const voiceDeletion = new VoiceDeletionService({ pool: voicePool, vault: voiceCredentialVault, artifacts: voiceArtifacts })
const privateVoices = new PrivateVoiceService({ pool: voicePool, contexts: voiceContexts, operations: voiceOperations, artifacts: voiceArtifacts, deletion: voiceDeletion })
registerVoiceResourceRoutes(app, voiceDeletion)
registerVoiceConfigurationRoutes(app, new VoiceConfigurationService(voicePool, voiceCredentialVault))
registerVoiceServiceRoutes(app, privateVoices)
const protocolManifest = new ProtocolManifestRegistry(BUILTIN_PROTOCOLS)
const modelServiceV2Sync = new ModelServiceV2Sync(voicePool, protocolManifest)
registerModelCapabilityRoutes(app, new ModelCapabilityService(voicePool, protocolManifest))
const pricingPlanService = new PricingPlanService(pricingPlanRepository)
registerPricingCenterRoutes(app, pricingPlanService)
const modelOperations = new ModelOperationRepository(voicePool)
const modelInvocation = new ModelInvocationService(new ProtocolAdapterRegistry(protocolManifest, [new MockVideoJobAdapter(), new MockEmbeddingAdapter()]))
const modelTasks = new ModelTaskService({
  capabilities: async (user, id) => {
    const [rows] = await voicePool.query(`SELECT c.id,c.task_type AS taskType,c.protocol_adapter AS protocolAdapter,c.config_revision AS configRevision,c.status,
      c.upstream_account_id AS upstreamAccountId,c.connection_role AS connectionRole,c.config_json AS config,m.id AS providerModelId,
      m.model_id AS upstreamModel,p.id AS providerId,p.base_url AS baseUrl,p.timeout_ms AS timeoutMs
      FROM ai_model_task_capabilities c JOIN ai_provider_models m ON m.id=c.provider_model_id JOIN ai_model_providers p ON p.id=m.provider_id
      WHERE c.id=? AND c.organization_id=? AND c.status='enabled' AND m.archived_at IS NULL AND m.status='enabled' AND p.status='enabled' LIMIT 1`, [id, user.organizationId])
    if (!rows[0]) throw Object.assign(new Error('模型任务能力不存在或未授权'), { statusCode: 404, code: 'MODEL_TASK_NOT_FOUND' })
    const allowed = await allowedProviderModelIdSetForUser(user.id)
    if (allowed && !allowed.has(rows[0].providerModelId)) throw Object.assign(new Error('当前账号无权使用此模型'), { statusCode: 403, code: 'MODEL_TASK_FORBIDDEN' })
    return rows[0]
  },
  pricing: pricingPlanService,
  invocation: modelInvocation,
  operations: modelOperations,
  contextResolver: (user, capability) => resolveTaskModelKeyContext(voicePool, materializeModelProviderKey, user, capability),
})
registerModelTaskRoutes(app, modelTasks)

registerUserRoutes(app, {
  findUserById,
  findUserByUsername,
  saveUploadFile,
  listUsers,
  sanitizeUser,
  assertCanManageUser,
  upsertUser,
  deleteUserAccount,
  listUserGroups,
  upsertUserGroup,
  listUserGroupMembers,
  saveUserGroupMembers,
  listUserGroupPermissions,
  saveUserGroupPermissions,
  deleteUserGroup,
})

registerUserUsageReportRoutes(app, { includeSupply: Boolean(authorizationClient) })
registerAdminBusinessRoutes(app, {
  listCenterSuppliers,
  findCenterSupplierById,
  upsertCenterSupplier,
  resetCenterSupplierToken,
  deleteCenterSupplier: organizationRepository.deleteCenterSupplier,
  listProjectsForUser,
  findProjectById,
  upsertProject,
  deleteProject,
  listBuildsForUser,
  listVisibleWorkers,
  getSourceVersionInfo,
  diagnosticsInfo,
  listEndUsersForAdmin,
  createEndUserByAdmin,
  assertCanAccessEndUser,
  assertCanOperateEndUser,
  canAccessEndUser,
  findEndUserById,
  updateEndUserStatus,
  resetEndUserPassword,
  getEndUserModelAccess,
  saveEndUserModelAccess,
  adjustEndUserCredits,
  setEndUserModelGatewayKey,
  setEndUserModelPointsPerUsd,
  getPlatformSettings,
  fetchProviderTokenInfo,
  listCreditLedger,
  listCreditLedgerPage,
  previewSecret,
})

registerBuildRoutes(app, {
  officialResources: process.env.AI_OFFICIAL_AUTHORIZATION_MODE === 'center' ? officialResourceClient({ centerUrl: process.env.AI_LICENSE_CENTER_URL }) : null,
  findProjectById,
  findActiveBuildForProject,
  assertBuildQuota,
  createBuild,
  submitBuildToCenter,
  prepareBuildCenterBrand,
  findBuildById,
  getBuildCenterConfig,
  resetBuildForRetry,
  buildCenterApi,
  updateBuild,
  startReleaseBuild,
  createCenterBuild,
  normalizeBuild,
  releaseBuild,
  cleanupBuildArtifacts,
  supplierLicensePayload,
  reserveCenterSupplierProject,
  releaseCenterSupplierProject,
  exportModelServiceConfigForCenter,
  listWorkers,
  claimNextBuild,
  projectToBrand,
  applyProjectReleaseFeedUrl,
  getSourceVersionInfo,
  touchWorker,
  appendBuildLog,
})

app.use((err, _req, res, _next) => {
  console.error('[ai-admin]', err)
  writeAppLog('error', err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err))
  const statusCode = Number(err?.statusCode || 500)
  res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
})

const updateEnvMigration = await migrateOfficialUpdateEnvFile(path.join(repoRoot, '.env'))
if (updateEnvMigration.changed) console.log(`[ai-admin] migrated official update sources; backup: ${updateEnvMigration.backupPath}`)

const uploadStorageMigration = await migrateLegacyUploadStorage({ legacyDir: LEGACY_UPLOAD_DIR, uploadDir: UPLOAD_DIR })
if (uploadStorageMigration.migratedFiles > 0) {
  console.log(`[ai-admin] migrated ${uploadStorageMigration.migratedFiles} legacy upload file(s) to ${UPLOAD_DIR}`)
}

pool = await initDatabase({
  dbHost: DB_HOST,
  dbPort: DB_PORT,
  dbUser: DB_USER,
  dbPassword: DB_PASSWORD,
  dbName: DB_NAME,
  adminUser: ADMIN_USER,
  adminPassword: ADMIN_PASSWORD,
  publicUpdateBaseUrl: PUBLIC_UPDATE_BASE_URL,
  defaultPlatformSettings,
  safeUsername,
  hashPassword,
  seedDefaultRoleTemplates,
  seedDefaultModelProviderData,
  setPool,
  centerMode: CENTER_SUPPLIER_MANAGEMENT_ENABLED,
  supplierId: BUILD_CENTER_SUPPLIER_ID,
  permissionKeys: permissionCatalogItems().map((item) => item.key),
})
await assertAccountingRuntime(pool, Boolean(authorizationClient))
await commerceRuntime?.startMonitoring()
await resourcesRuntime?.start()
const updateDatabaseMigration = await migrateOfficialUpdateDatabaseSettings(pool)
if (updateDatabaseMigration.changedRows > 0) console.log(`[ai-admin] migrated ${updateDatabaseMigration.changedRows} saved official update source setting(s)`)
await reconcileCenterSupplierOrganizations()
await cleanupRetiredBuiltinSkills({ pool, actorId: SUPER_ADMIN_ID })
await ensurePublicStaticAliases()
if (CENTER_SUPPLIER_MANAGEMENT_ENABLED) {
  const stagingMigration = await normalizeExistingWorkerStagingDirectories({ rootDir: PUBLIC_PREVIEW_ROOT })
  console.log(`[ai-admin] worker staging permissions normalized=${stagingMigration.normalized.length} skipped=${stagingMigration.skipped.length} errors=${stagingMigration.errors.length}`)
  for (const error of stagingMigration.errors) {
    console.warn(`[ai-admin] unable to normalize worker staging directory ${error.name}: ${error.message}`)
  }
}
await voiceOperations.recoverInterrupted()
await modelOperations.recoverInterrupted()
await voiceArtifacts.cleanExpired().catch((error) => writeAppLog('voice-service', `artifact cleanup failed: ${error.message}`))

let storageCleanupRunning = false
async function cleanFailedBuildStorage() {
  if (storageCleanupRunning) return
  storageCleanupRunning = true
  try {
    const result = await cleanupFailedBuildStorage({
      previewRoot: PUBLIC_PREVIEW_ROOT,
      temporaryRoots: ['artifact-staging', 'artifact-release'].map((name) => path.join(repoRoot, 'data', name)),
      findBuild: async (id) => localizingBuildIds.has(id) ? null : findBuildById(id),
    })
    if (result.removed.length) writeAppLog('storage', `Removed ${result.removed.length} expired failed build directories`)
  } catch (error) {
    writeAppLog('storage', `Cleanup failed: ${error.message}`)
  } finally { storageCleanupRunning = false }
}
await cleanFailedBuildStorage()
setInterval(cleanFailedBuildStorage, 24 * 60 * 60 * 1000).unref()

process.on('uncaughtException', (err, origin) => {
  const detail = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err)
  writeAppLog('system', `uncaughtException origin=${origin} pid=${process.pid} ${detail}`)
  console.error('[ai-admin] uncaughtException', origin, err)
  // 记录后按默认行为退出进程，交由 PM2 重启，避免进程进入不可用状态
  setImmediate(() => process.exit(1))
})

process.on('unhandledRejection', (reason, promise) => {
  const detail = reason instanceof Error ? `${reason.message}\n${reason.stack || ''}` : String(reason ?? '')
  writeAppLog('system', `unhandledRejection pid=${process.pid} ${detail}`)
  console.error('[ai-admin] unhandledRejection', reason)
})

app.listen(PORT, HOST, () => {
  writeAppLog('system', `boot version=${process.env.npm_package_version || PACKAGE_VERSION} pid=${process.pid} node=${process.version} build=${BUILD_MODE} host=${HOST} port=${PORT}`)
  console.log(`[ai-admin] listening on http://${HOST}:${PORT}`)
  console.log(`[ai-admin] build mode: ${BUILD_MODE}`)
  console.log(`[ai-admin] database: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`)
  if (ADMIN_PASSWORD === 'change-me-now') {
    console.warn('[ai-admin] Please set AI_ADMIN_PASSWORD before exposing this service.')
  }
  if (!WORKER_TOKEN) {
    console.warn('[ai-admin] AI_BUILD_MODE=worker requires AI_WORKER_TOKEN.')
  }
  startBuildCenterSyncScheduler({
    sync: () => syncCenterBuilds({ platformScope: true }),
    logger: {
      log: (message) => writeAppLog('build-center-sync', message),
      error: (message) => writeAppLog('build-center-sync', `ERROR ${message}`),
    },
  })
})
