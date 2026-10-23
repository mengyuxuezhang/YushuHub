import { createMcpVersion, publishCatalogVersion, saveCatalogDistribution, uploadSkillVersion } from '@/api/catalog-resources'

function ok(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

describe('skill and MCP catalog API contracts', () => {
  it('uploads a skill version as multipart form data', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({ id: 'v1', version: '1.0.0', status: 'draft' }))
    const file = new File(['zip-content'], 'skill.zip', { type: 'application/zip' })
    await uploadSkillVersion('skill-1', { version: '1.0.0', releaseNotes: '首版', minDesktopVersion: '', packageFile: file })
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.body).toBeInstanceOf(FormData)
    expect((init?.body as FormData).get('package')).toBe(file)
  })

  it('creates a JSON MCP version without exposing secrets in URL parameters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({ id: 'v1', version: '1.0.0', status: 'draft' }))
    await createMcpVersion('browser-tools', { version: '1.0.0', releaseNotes: '', minDesktopVersion: '', config: { transport: 'stdio', command: 'npx.cmd', args: ['pkg@1.0.0'], env: {} } })
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/curated-mcps/browser-tools/versions')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
  })

  it('uses the correct version selector and distribution endpoint for each market', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({ status: 'published' }))
    await publishCatalogVersion('skill', 'skill-1', { id: 'version-id', version: '1.0.0', status: 'draft' }, ['personal'])
    await publishCatalogVersion('mcp', 'mcp-1', { id: 'version-id', version: '2.0.0', status: 'draft' }, ['personal'])
    await saveCatalogDistribution('skill', 'skill-1', { enabled: true, selectedVersionId: 'version-id', deliveryPolicy: 'market', versionPolicy: 'manual', audienceType: 'all', membershipCardIds: [] })
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/api/curated-skills/skill-1/versions/version-id/publish',
      '/api/curated-mcps/mcp-1/versions/2.0.0/publish',
      '/api/curated-skill-distributions/skill-1',
    ])
  })
})
