export function preserveConfiguredSecret(inputValue, existingValue, configurationEnabled = true) {
  const submitted = String(inputValue || '').trim()
  if (submitted) return submitted
  return configurationEnabled ? String(existingValue || '') : ''
}

export function withEffectiveBuildCenterSettings(settings, environment = {}) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const databaseUrl = String(source.buildCenterUrl || '').trim()
  const databaseSupplierId = String(source.buildCenterSupplierId || '').trim()
  const databaseToken = String(source.buildCenterToken || '').trim()
  const environmentUrl = String(environment.url || environment.buildCenterUrl || '').trim()
  const environmentSupplierId = String(environment.supplierId || environment.buildCenterSupplierId || '').trim()
  const environmentToken = String(environment.token || environment.buildCenterToken || '').trim()
  const effectiveUrl = databaseUrl || environmentUrl
  const effectiveSupplierId = databaseSupplierId || environmentSupplierId
  const effectiveToken = databaseToken || environmentToken
  const configured = Boolean(effectiveUrl && effectiveSupplierId && effectiveToken)
  const databaseParts = [databaseUrl, databaseSupplierId, databaseToken].filter(Boolean).length
  const environmentParts = [!databaseUrl && environmentUrl, !databaseSupplierId && environmentSupplierId, !databaseToken && environmentToken].filter(Boolean).length
  const configSource = !configured ? 'none' : databaseParts === 3 ? 'database' : environmentParts === 3 ? 'environment' : 'mixed'
  return {
    ...source,
    buildCenterConfigured: configured,
    buildCenterConfigSource: configSource,
    effectiveBuildCenterUrl: effectiveUrl,
    effectiveBuildCenterSupplierId: effectiveSupplierId,
    buildCenterTokenConfigured: Boolean(effectiveToken),
  }
}

export function resolveBuildCenterSettingsUpdate(input, existing, environment, normalize) {
  const read = (key) => String((Object.hasOwn(input, key) ? input[key] : existing[key]) || '').trim()
  const url = read('buildCenterUrl').replace(/\/$/, '')
  const supplierId = read('buildCenterSupplierId')
  const submittedToken = String(input.buildCenterToken || '').trim()
  const previous = { url: existing.buildCenterUrl, supplierId: existing.buildCenterSupplierId, token: existing.buildCenterToken }
  if (url === previous.url && supplierId === previous.supplierId && !submittedToken) return previous
  if (!url && !supplierId && !submittedToken) return { url: '', supplierId: '', token: '' }

  const token = submittedToken || previous.token
  const effective = normalize({
    url: url || environment.url,
    supplierId: supplierId || environment.supplierId,
    token: token || environment.token,
  })
  if (!effective.enabled) {
    throw new Error(effective.url ? '请填写构建中心的供应商 ID 和 Token，或将官方构建中心留空' : '请填写官方构建中心 URL')
  }
  return { url: url ? effective.url : '', supplierId: supplierId ? effective.supplierId : '', token }
}

const PUBLIC_PLATFORM_SETTING_KEYS = [
  'systemName',
  'systemSubtitle',
  'loginTitle',
  'loginSubtitle',
  'loginBackgroundUrl',
  'loginPanelColor',
  'loginContent',
  'primaryColor',
  'logoText',
  'crystalFaceTexts',
]

export function sanitizePublicPlatformSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}
  return Object.fromEntries(PUBLIC_PLATFORM_SETTING_KEYS.filter((key) => key in source).map((key) => [key, source[key]]))
}
