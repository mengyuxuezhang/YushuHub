const COLUMNS = 'id project_id owner_user_id organization_id requested_by version status log error artifact_dir public_url release_url release_status release_error files transfer_progress remote_build_id center_supplier_id center_local_build_id claimed_by started_at finished_at released_at created_at updated_at'.split(' ')

// Select the metadata needed by status/list consumers without reading embedded
// branding images from MySQL. The complete brand remains stored for packaging.
export function buildStatusColumns(prefix = '') {
  if (!['', 'b.'].includes(prefix)) throw new Error('Invalid build table prefix')
  const brand = `${prefix}brand_json`
  return [...COLUMNS.map(column => prefix + column), `JSON_OBJECT(
    'clientMode', 'personal',
    'sourceBuildId', JSON_UNQUOTE(JSON_EXTRACT(${brand}, '$.sourceBuildId')),
    'sourceProjectId', JSON_UNQUOTE(JSON_EXTRACT(${brand}, '$.sourceProjectId'))
  ) AS brand_json`].join(', ')
}

export function compactBuildStatus(build) {
  const brand = build.brand
  return { ...build, brandMetadataOnly: true, brand: brand ? {
    clientMode: 'personal', sourceBuildId: brand.sourceBuildId, sourceProjectId: brand.sourceProjectId,
  } : null }
}
