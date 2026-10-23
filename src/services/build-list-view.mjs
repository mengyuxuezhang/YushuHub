// List screens need status, artifacts and logs, but never embedded branding images.
// Keep the original records intact for builds, retries and legacy API consumers.
export function compactBuildList(result) {
  const compact = (build) => ({ ...build, brand: build.brand ? { clientMode: 'personal' } : null })
  return Array.isArray(result)
    ? result.map(compact)
    : { ...result, items: result.items.map(compact) }
}
