import { applySupplierLicenseExpiration, shouldApplyOrganizationAuthorization } from './supplier-license-contract.mjs'

export function normalizeSupplierLicense(input = {}, defaults = {}, now = Date.now()) {
  return applySupplierLicenseExpiration({
    ...defaults,
    ...input,
    licenseType: String(input.licenseType || defaults.licenseType),
    organizationId: String(input.organizationId || input.id || defaults.organizationId || ''),
    agentLevel: Number(input.agentLevel || 1),
    authorizationVersion: Number(input.authorizationVersion || 0),
    capabilities: Array.isArray(input.capabilities) ? input.capabilities : [],
    maxProjects: Number(input.maxProjects || 0), maxBuilds: Number(input.maxBuilds || 0),
    usedProjects: Number(input.usedProjects || 0), usedBuilds: Number(input.usedBuilds || 0),
    allowAgentManagement: Boolean(input.allowAgentManagement),
    allowSupplierManagement: Boolean(input.allowSupplierManagement),
    allowPlatformSettings: Boolean(input.allowPlatformSettings),
    allowCustomBrand: Boolean(input.allowCustomBrand),
    allowCustomApiProviders: Boolean(input.allowCustomApiProviders),
  }, now)
}

export function createSupplierLicenseService({ officialCenterEnabled, defaults, getConfig, configCacheKey, listProjectIds, centerApi, organizationRepository, now = Date.now }) {
  let cache = { value: null, checkedAt: 0, key: '' }
  const normalize = (license) => normalizeSupplierLicense(license, defaults, now())
  function resetSupplierLicenseCache() { cache = { value: null, checkedAt: 0, key: '' } }

  async function getSupplierLicense(options = {}) {
    if (officialCenterEnabled) return normalize({ ...defaults, id: 'official-center', licenseType: 'internal', allowSupplierManagement: true, allowCustomApiProviders: true, verified: true, message: '官方构建中心权限' })
    let config, key = ''
    const timestamp = now()
    try {
      config = await getConfig()
      if (!config.enabled) return normalize({ ...defaults, verified: true, message: '未配置官方构建中心，使用本地默认权限' })
      key = configCacheKey(config)
      if (!options.force && cache.value && cache.key === key && timestamp - cache.checkedAt < 60_000) {
        return normalize(cache.value)
      }
      const projectIds = await listProjectIds()
      const license = normalize({ ...await centerApi('/api/center/license', { supplierId: config.supplierId, projectIds }, config), verified: true })
      if (shouldApplyOrganizationAuthorization(license)) {
        // Natural expiry is checked at runtime; do not permanently disable the
        // organization and prevent its administrator from logging in to renew.
        await organizationRepository.syncLocalRootAuthorization({
          organizationId: config.supplierId, externalId: license.organizationId || config.supplierId,
          name: license.name || '一级代理根组织', status: license.configuredStatus === 'expired' ? 'enabled' : license.configuredStatus,
          authorizationVersion: license.authorizationVersion, capabilities: license.capabilities,
          expiresAt: license.expiresAt,
        }, { organizationId: config.supplierId, userId: 'official-center-sync' })
      }
      cache = { value: license, checkedAt: timestamp, key }
      return license
    } catch (err) {
      const cached = key && cache.key === key ? cache.value : null
      const rejected = [401, 403].includes(err?.statusCode) || err?.code === 'SUPPLIER_LICENSE_EXPIRED'
      if (!rejected && cached && timestamp - cache.checkedAt <= 24 * 60 * 60_000) {
        return normalize({ ...cached, verified: true, stale: true, message: `授权缓存有效，实时校验失败：${err instanceof Error ? err.message : String(err)}` })
      }
      // An authoritative rejection must not be turned into a valid stale grant
      // on the next request after a transient network error.
      if (rejected) resetSupplierLicenseCache()
      return normalize({
        ...defaults, id: config?.supplierId || '', expiresAt: cached?.expiresAt || null,
        verified: false, allowAgentManagement: false, allowSupplierManagement: false,
        allowPlatformSettings: true, allowCustomBrand: false, allowCustomApiProviders: false,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { getSupplierLicense, resetSupplierLicenseCache }
}
