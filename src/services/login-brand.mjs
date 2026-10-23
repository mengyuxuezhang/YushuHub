export const LOGIN_DESIGNS = Object.freeze(['nature', 'minimal', 'orbit', 'editorial'])

export function normalizeLoginDesign(value = 'nature') {
  if (!LOGIN_DESIGNS.includes(value)) throw new Error('登录页方案不合法')
  return value
}

// Preserve the submitted build snapshot, not the central project's older defaults.
export function preserveSubmittedLoginBrandFields(target, source) {
  if (!target || !source || typeof source !== 'object') return target
  target.loginDesign = normalizeLoginDesign(source.loginDesign)
  delete target.loginBackgroundUrl
  for (const key of ['loginLogoUrl', 'loginTitle', 'loginSubtitle', 'loginHeroTitle', 'loginHeroSubtitle', 'clientMode']) {
    const value = String(source[key] || '').trim()
    if (value) target[key] = value
  }
  return target
}
