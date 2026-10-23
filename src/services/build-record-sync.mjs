function nonEmptyText(value) {
  return String(value || '').trim()
}

export function buildNeedsRemoteMetadata(build) {
  return !nonEmptyText(build?.version) || !nonEmptyText(build?.brand?.clientMode)
}

export function remoteBuildMetadataPatch(localBuild, remoteBuild) {
  const patch = {}
  const version = nonEmptyText(remoteBuild?.version)
  if (version && version !== nonEmptyText(localBuild?.version)) patch.version = version

  const remoteBrand = remoteBuild?.brand
  if (remoteBrand && typeof remoteBrand === 'object' && !Array.isArray(remoteBrand)) {
    const localBrand = localBuild?.brand && typeof localBuild.brand === 'object' && !Array.isArray(localBuild.brand)
      ? localBuild.brand
      : {}
    const mergedBrand = { ...localBrand, ...remoteBrand, clientMode: 'personal' }
    patch.brand = mergedBrand
  }
  return patch
}

