export const BUILD_BRAND_ASSET_FIELDS = Object.freeze([
  ['logoUrl', 'Logo'],
  ['iconUrl', '安装包/窗口图标'],
  ['contactQrUrl', '联系方式二维码'],
  ['loginLogoUrl', '登录页 Logo'],
])

export async function resolveBuildBrandAssets(brand, resolveAsset) {
  if (!brand || typeof resolveAsset !== 'function') return brand
  delete brand.loginBackgroundUrl
  const resolved = await Promise.all(BUILD_BRAND_ASSET_FIELDS.map(async ([field, label]) => [
    field,
    await resolveAsset(brand[field], label),
  ]))
  for (const [field, value] of resolved) brand[field] = value
  return brand
}
