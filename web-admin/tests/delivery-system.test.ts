import { applySelfUpdate, changePassword, createBuild, getAgentSourceVersion, getSelfUpdateStatus, listBuildPage, listWorkers, publishBuild, saveProject, saveSettings, saveSelfUpdateSource, uploadProjectAsset } from '@/api/delivery-system'
import { projectMenuRows, serializeProjectMenus } from '@/utils/project-menus'
import { buildArtifactLinks, buildFileUrl, buildPublicUrl, primaryBuildArtifact } from '@/utils/build-artifacts'
import { diagnosticsFilename, formatDiagnosticsReport } from '@/utils/diagnostics-export'
import { projectVersionState } from '@/utils/project-version'
import { buildClientModeLabel, buildExecutionLabel, buildReleaseLabel } from '@/utils/build-records'
import { deliverySearchValues } from '@/composables/delivery/useDeliverySystem'

const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } }))

describe('delivery and system API contracts', () => {
  it('opts into complete histories only for the timeline reads', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({}))
    await getAgentSourceVersion(true)
    await getSelfUpdateStatus(true)
    await getSelfUpdateStatus()
    expect(f.mock.calls.map(call => String(call[0]))).toEqual(['/api/source-version?history=all', '/api/self-update/status?history=all', '/api/self-update/status'])
  })
  it('forces personal mode when persisting project branding', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({}))
    await saveProject({ id: 'enterprise-app', clientMode: 'enterprise' })
    expect(f.mock.calls[0][1]?.body).toContain('personal')
  })

  it('edits external links only while preserving stored built-in menus', () => {
    const original = [{ key: 'chat', type: 'route', label: 'AI 对话', visible: false }, { key: 'help', label: '帮助中心', type: 'external', url: 'https://help.example.com' }]
    const rows = projectMenuRows(original)
    expect(rows).toHaveLength(1)
    expect(projectMenuRows(undefined)).toEqual([])
    expect(serializeProjectMenus(rows, original)[0]).toEqual(original[0])
    expect(serializeProjectMenus(rows).find(item => item.key === 'help')).toMatchObject({ type: 'external', url: 'https://help.example.com' })
  })

  it('uploads project assets through the protected upload endpoint', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({ url: '/uploads/logo.png' }))
    await uploadProjectAsset('logo.png', 'data:image/png;base64,AA==')
    expect(String(request.mock.calls[0][0])).toBe('/api/uploads')
    expect(String(request.mock.calls[0][1]?.body)).toContain('logo.png')
  })

  it('separates test build submission from user publishing', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({}))
    await createBuild('project/a')
    await publishBuild('build/a')
    expect(f.mock.calls.map((x) => String(x[0]))).toEqual(['/api/builds', '/api/builds/build%2Fa/publish'])
  })

  it('searches projects and workers through explicit visible fields', () => {
    expect(deliverySearchValues('projects', { id: 'p-1', appName: 'Demo', brandName: 'Brand', shortName: 'DB', secret: 'hidden' }, 'all')).toEqual(['Demo', 'Brand', 'DB', 'p-1'])
    expect(deliverySearchValues('workers', { id: 'worker-1', metadata: { hostname: 'builder', platform: 'win32', packageVersion: '3.0.0' }, expectedPackageVersion: '3.0.1', currentBuildId: 'build-1' }, 'version')).toEqual(['3.0.0', '3.0.1'])
  })

  it('serializes explicit build fields and status into the paged list request', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }))
    await listBuildPage({ search: '3.0.0', searchField: 'version', status: 'succeeded', page: 2, pageSize: 20 })
    expect(String(f.mock.calls[0][0])).toBe('/api/builds?page=2&pageSize=20&search=3.0.0&searchField=version&status=succeeded&sync=1&view=list')
  })

  it('creates encoded download links and selects the installer as the primary artifact', () => {
    const build = { publicUrl: 'http://downloads.example.com/staging/demo/', releaseUrl: 'http://downloads.example.com/releases/demo/', files: ['latest.yml', 'Demo Setup 1.0.0.exe', 'Demo Setup 1.0.0.exe.blockmap'] }
    expect(buildFileUrl(build.publicUrl, build.files[1])).toBe('http://downloads.example.com/staging/demo/Demo%20Setup%201.0.0.exe')
    expect(buildArtifactLinks(build)).toHaveLength(3)
    expect(primaryBuildArtifact(build)?.name).toBe('Demo Setup 1.0.0.exe')
    expect(primaryBuildArtifact(build, build.releaseUrl)?.url).toBe('http://downloads.example.com/releases/demo/Demo%20Setup%201.0.0.exe')
    expect(buildPublicUrl('javascript:alert(1)')).toBe('')
  })

  it('uses the personal client label and labels released builds', () => {
    expect(buildClientModeLabel({ brand: null })).toBe('个人客户端')
    expect(buildClientModeLabel({ brand: { clientMode: 'personal' } })).toBe('个人客户端')
    expect(buildReleaseLabel({ releasedAt: '2026-08-14T13:02:17Z', releaseUrl: 'https://updates.example.com/9999/' })).toBe('已推送')
    expect(buildReleaseLabel({ releaseStatus: 'publishing' })).toBe('正式包推送中')
  })

  it('distinguishes central compilation from downstream artifact synchronization', () => {
    expect(buildExecutionLabel({ status: 'queued' })).toBe('排队中')
    expect(buildExecutionLabel({ status: 'running' })).toBe('构建中')
    expect(buildExecutionLabel({ status: 'running', transferProgress: { phase: 'staging' } })).toBe('同步产物中')
  })

  it('keeps settings secrets and passwords in request bodies', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({}))
    await saveSettings({ smtpPass: 'secret' })
    await changePassword('old-secret', 'new-secret')
    expect(f.mock.calls.map((x) => String(x[0]))).toEqual(['/api/platform-settings', '/api/me/password'])
    expect(String(f.mock.calls[1][0])).not.toContain('new-secret')
  })

  it('keeps worker reads, update-source saves, and upgrade actions separate', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({}))
    await listWorkers()
    await getAgentSourceVersion()
    await saveSelfUpdateSource('https://updates.example.com/latest.json')
    await applySelfUpdate()
    expect(f.mock.calls.map((x) => String(x[0]))).toEqual(['/api/workers', '/api/source-version', '/api/self-update/config', '/api/self-update/apply'])
  })

  it('exports a readable diagnostic report with runtime and log details', () => {
    const report = formatDiagnosticsReport({
      generatedAt: '2026-08-14T10:20:30.000Z',
      version: '1.2.3-test.ui.1',
      node: 'v24.14.0',
      updateCheckUrls: [{ projectId: 'personal', latestUrl: 'https://example.com/latest.yml' }],
      appLogTail: 'service ready',
    })
    expect(report).toContain('Agent AI 管理后台诊断报告')
    expect(report).toContain('service ready')
    expect(report).toContain('https://example.com/latest.yml')
    expect(diagnosticsFilename('2026-08-14T10:20:30.000Z')).toBe('agent-ai-diagnostics-2026-08-14T10-20-30-000Z.log')
  })

  it('distinguishes current, stale, and unavailable project build versions', () => {
    expect(projectVersionState({ version: '3.0.0', status: 'succeeded' }, '3.0.0')).toMatchObject({ stateClass: 'current', current: true })
    expect(projectVersionState({ version: '2.9.0', status: 'succeeded' }, '3.0.0')).toMatchObject({ stateClass: 'stale', current: false })
    expect(projectVersionState({ version: '3.0.0', status: 'failed' }, '3.0.0')).toMatchObject({ stateClass: 'stale', current: false })
    expect(projectVersionState(null, '')).toMatchObject({ stateClass: 'unknown', current: false })
  })
})
