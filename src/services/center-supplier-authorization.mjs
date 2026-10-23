import crypto from 'node:crypto'
import { db } from '../db/pool.mjs'
import { safeCenterId, slugify } from '../utils/slug.mjs'
import { parseLimit, parseFlag } from '../utils/parse.mjs'
import { createSecretToken, hashSecretToken } from '../utils/crypto.mjs'
import { parseSupplierExpiresAt, supplierAuthorizationState } from './supplier-license-contract.mjs'

export function normalizeCenterSupplier(row, now = Date.now()) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    notes: row.notes || '',
    status: row.status || 'enabled',
    ...supplierAuthorizationState(row.expires_at, row.status || 'enabled', now),
    licenseType: row.license_type || 'partner',
    organizationId: row.organization_id || row.id,
    agentLevel: 1,
    authorizationVersion: Number(row.authorization_version || 1),
    tokenPreview: row.token_preview || '',
    maxProjects: Number(row.max_projects || 0),
    maxBuilds: Number(row.max_builds || 0),
    buildCount: Number(row.build_count || 0),
    usedProjects: Number(row.usedProjects ?? row.used_projects ?? 0),
    usedBuilds: Number(row.usedBuilds ?? row.used_builds ?? row.build_count ?? 0),
    projectRegistryInitialized: Boolean(row.project_registry_initialized),
    allowAgentManagement: Boolean(row.allow_agent_management),
    allowSupplierManagement: Boolean(row.allow_supplier_management),
    allowPlatformSettings: Boolean(row.allow_platform_settings),
    allowCustomBrand: Boolean(row.allow_custom_brand),
    allowCustomApiProviders: Boolean(row.allow_custom_api_providers),
    lastSeenAt: row.last_seen_at,
    lastBuildAt: row.last_build_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeLicenseType(value) {
  const type = String(value || '').trim()
  return ['partner', 'internal'].includes(type) ? type : 'partner'
}

export function createCenterSupplierAuthorizationService({ organizationRepository, findCenterSupplierById, deploymentConfigForSupplier, centerSupplierOrganizationCapabilities }) {
  async function upsertCenterSupplier(input, existingSupplier = null, actor = { organizationId: 'platform', userId: 'admin' }) {
    const name = String(input.name || existingSupplier?.name || '').trim()
    if (!name) throw new Error('供应商名称不能为空')
    const notes = String(input.notes ?? existingSupplier?.notes ?? '').trim().slice(0, 500)
    const id = existingSupplier?.id || safeCenterId(input.id || `supplier-${slugify(name, 'agent')}-${crypto.randomBytes(3).toString('hex')}`, '供应商 ID')
    const status = (input.status ?? existingSupplier?.status) === 'disabled' ? 'disabled' : 'enabled'
    const licenseType = normalizeLicenseType(input.licenseType || existingSupplier?.license_type)
    const expiresAt = parseSupplierExpiresAt(input.expiresAt === undefined ? existingSupplier?.expires_at : input.expiresAt)
    const maxProjects = parseLimit(input.maxProjects ?? existingSupplier?.max_projects)
    const maxBuilds = parseLimit(input.maxBuilds ?? existingSupplier?.max_builds)
    const allowAgentManagement = parseFlag(input.allowAgentManagement, existingSupplier ? Boolean(existingSupplier.allow_agent_management) : true)
    const allowSupplierManagement = parseFlag(input.allowSupplierManagement, existingSupplier ? Boolean(existingSupplier.allow_supplier_management) : false)
    const allowPlatformSettings = parseFlag(input.allowPlatformSettings, existingSupplier ? Boolean(existingSupplier.allow_platform_settings) : true)
    const allowCustomBrand = parseFlag(input.allowCustomBrand, existingSupplier ? Boolean(existingSupplier.allow_custom_brand) : true)
    const allowCustomApiProviders = parseFlag(input.allowCustomApiProviders, existingSupplier ? Boolean(existingSupplier.allow_custom_api_providers) : false)
    const authorizationVersion = Number(existingSupplier?.authorization_version || 0) + 1
    let plainToken = ''
    let tokenHash = existingSupplier?.token_hash || ''
    let tokenPreview = existingSupplier?.token_preview || ''
    if (!existingSupplier) {
      plainToken = createSecretToken()
      tokenHash = hashSecretToken(plainToken)
      tokenPreview = plainToken.slice(-8)
    }

    await db().query(
      `INSERT INTO ai_center_suppliers (
         id, name, notes, status, license_type, expires_at, token_hash, token_preview, max_projects, max_builds,
         allow_agent_management, allow_supplier_management, allow_platform_settings, allow_custom_brand, allow_custom_api_providers,
         organization_id, business_mode, authorization_version
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         notes = VALUES(notes),
         status = VALUES(status),
         license_type = VALUES(license_type),
         expires_at = VALUES(expires_at),
         max_projects = VALUES(max_projects),
         max_builds = VALUES(max_builds),
         allow_agent_management = VALUES(allow_agent_management),
         allow_supplier_management = VALUES(allow_supplier_management),
         allow_platform_settings = VALUES(allow_platform_settings),
         allow_custom_brand = VALUES(allow_custom_brand),
         allow_custom_api_providers = VALUES(allow_custom_api_providers),
         organization_id = VALUES(organization_id),
         business_mode = VALUES(business_mode),
         authorization_version = VALUES(authorization_version)`,
      [
        id,
        name,
        notes,
        status,
        licenseType,
        expiresAt ? new Date(expiresAt) : null,
        tokenHash,
        tokenPreview,
        maxProjects,
        maxBuilds,
        allowAgentManagement ? 1 : 0,
        allowSupplierManagement ? 1 : 0,
        allowPlatformSettings ? 1 : 0,
        allowCustomBrand ? 1 : 0,
        allowCustomApiProviders ? 1 : 0,
        id,
        'personal',
        authorizationVersion,
      ],
    )
    await organizationRepository.upsertFirstLevelOrganization({
      expiresAt,
      id, externalId: id, name, status, authorizationVersion,
    }, actor)
    await organizationRepository.replaceOrganizationCapabilities(
      id,
      centerSupplierOrganizationCapabilities({
        allowAgentManagement,
        allowSupplierManagement,
        allowPlatformSettings,
        allowCustomBrand,
        allowCustomApiProviders,
        maxProjects,
        maxBuilds,
      }),
      actor,
    )
    await db().query(
      `INSERT INTO ai_organization_audit_logs
        (id, organization_id, actor_user_id, event_type, target_type, target_id, detail_json)
       VALUES (?, 'platform', ?, 'center_supplier_authorization_saved', 'supplier', ?, ?)`,
      [crypto.randomUUID(), actor.userId || '', id, JSON.stringify({ expiresAt, previousExpiresAt: parseSupplierExpiresAt(existingSupplier?.expires_at), status, authorizationVersion })],
    )
    const saved = normalizeCenterSupplier(await findCenterSupplierById(id))
    return {
      ...saved,
      capabilities: await organizationRepository.listOrganizationCapabilities(id),
      token: plainToken,
      deploymentConfig: deploymentConfigForSupplier(saved, plainToken),
    }
  }
  return { upsertCenterSupplier }
}
