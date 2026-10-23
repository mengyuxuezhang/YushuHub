import { getDashboardSummary } from '@/api/dashboard'

function jsonResponse(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
}

describe('dashboard summary', () => {
  it('loads only resources allowed by the current account', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input)
      if (path === '/api/source-version') return jsonResponse({ version: 'v-test' })
      if (path === '/api/curated-agents') return jsonResponse([{ id: 'a1' }, { id: 'a2' }])
      throw new Error(`unexpected dashboard request: ${path}`)
    })

    const summary = await getDashboardSummary((permission) => permission === 'curated_agents.view')
    expect(summary.sourceVersion).toBe('v-test')
    expect(summary.marketCount).toBe(2)
    expect(summary.projectCount).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('aggregates project, build, worker and market state', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const responses: Record<string, unknown> = {
        '/api/source-version': { tag: 'v1.2.3' },
        '/api/projects': [{ id: 'p1' }],
        '/api/builds?view=list': [{ status: 'running' }, { status: 'success' }],
        '/api/workers': [{ status: 'online' }, { status: 'offline' }],
        '/api/curated-agents': [{ id: 'a1' }],
        '/api/curated-skills': [{ id: 's1' }],
        '/api/curated-mcps': [{ id: 'm1' }],
      }
      return jsonResponse(responses[String(input)])
    })

    const summary = await getDashboardSummary(() => true)
    expect(summary).toEqual(expect.objectContaining({
      sourceVersion: 'v1.2.3', projectCount: 1, buildCount: 2, runningBuildCount: 1, succeededBuildCount: 1,
      failedBuildCount: 0, workerOnlineCount: 1, workerTotalCount: 2, marketCount: 3,
      agentCount: 1, skillCount: 1, mcpCount: 1,
    }))
    expect(summary.recentBuilds).toHaveLength(2)
  })

  it('shows local counts before the remote source request completes', async () => {
    let finishSource!: (response: Response) => void
    const source = new Promise<Response>(resolve => { finishSource = resolve })
    vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
      if (String(input) === '/api/source-version') return source
      if (String(input) === '/api/projects') return jsonResponse([{ id: 'p1' }])
      throw new Error(`unexpected request: ${input}`)
    })
    const progress = vi.fn()
    const pending = getDashboardSummary(permission => permission === 'projects.manage', progress)
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(expect.objectContaining({ projectCount: 1, workerTotalCount: null })))
    finishSource(await jsonResponse({ version: '3.0.20' }))
    expect(await pending).toMatchObject({ projectCount: 1, sourceVersion: '3.0.20' })
  })
})
