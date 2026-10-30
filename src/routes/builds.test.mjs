import assert from 'node:assert/strict'
import test from 'node:test'

import { isCenterDelegatedBuild, registerBuildRoutes } from './builds.mjs'

function publishHandler(deps) {
  const routes = new Map()
  const app = {
    get() {},
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers.at(-1)) },
    put() {},
    patch() {},
    delete() {},
    use() {},
  }
  registerBuildRoutes(app, new Proxy(deps, { get: (target, key) => target[key] || (() => {}) }))
  return routes.get('POST /api/builds/:id/publish')
}

function postHandler(path, deps) {
  const routes = new Map()
  const app = {
    get() {},
    post(routePath, ...handlers) { routes.set(`POST ${routePath}`, handlers.at(-1)) },
    put() {},
    patch() {},
    delete() {},
    use() {},
  }
  registerBuildRoutes(app, new Proxy(deps, { get: (target, key) => target[key] || (() => {}) }))
  return routes.get(`POST ${path}`)
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

test('isCenterDelegatedBuild only marks official-center mirror records', () => {
  assert.equal(isCenterDelegatedBuild({ centerSupplierId: 'supplier-demo' }), true)
  assert.equal(isCenterDelegatedBuild({ centerSupplierId: '  ' }), false)
  assert.equal(isCenterDelegatedBuild({ remoteBuildId: 'remote-build' }), false)
})

test('license metadata exposes expiry to old and new downstream clients without changing configured status', async () => {
  const handler = postHandler('/api/center/license', {
    supplierLicensePayload: async () => ({ id: 'supplier-a', status: 'enabled', expiresAt: '2020-01-01T00:00:00Z', authorizationVersion: 2 }),
  })
  const res = responseRecorder()
  await handler({ body: {}, centerSupplier: { id: 'supplier-a' } }, res)
  assert.equal(res.body.data.status, 'disabled')
  assert.equal(res.body.data.authorizationStatus, 'expired')
  assert.equal(res.body.data.configuredStatus, 'enabled')
  assert.equal(res.body.data.expiresAt, '2020-01-01T00:00:00.000Z')
})

test('build center worker response carries the authoritative source match for downstream admins', async () => {
  const handler = postHandler('/api/center/workers', {
    listWorkers: async () => [{ id: 'worker-1', metadata: { packageVersion: '3.0.0-beta.77' } }],
    getSourceVersionInfo: async () => ({ version: '3.0.0-beta.77' }),
  })
  const res = responseRecorder()

  await handler({}, res, (error) => { throw error })

  assert.equal(res.body.data[0].expectedPackageVersion, '3.0.0-beta.77')
  assert.equal(res.body.data[0].versionMatchesSource, true)
})

test('build center exposes the authoritative Desktop source version and bounded history', async () => {
  const sourceInfo = {
    version: '3.0.0-beta.78',
    commit: '75c1c12630c3def0443a4793390b90394692323c',
    sourceOnly: true,
    history: [
      { version: '3.0.0-beta.78', releaseNotes: 'current' },
      { version: '3.0.0-beta.77', releaseNotes: 'previous' },
    ],
  }
  const handler = postHandler('/api/center/source-version', {
    getSourceVersionInfo: async () => sourceInfo,
  })
  const res = responseRecorder()

  await handler({}, res, (error) => { throw error })

  assert.deepEqual(res.body, { success: true, data: sourceInfo })
})

test('downstream timeline can explicitly request the complete build-center archive', async () => {
  const sourceInfo = { version: '3.0.73', history: [{ version: '3.0.73', releaseNotes: 'Canonical current notes' }] }
  const handler = postHandler('/api/center/source-version', { getSourceVersionInfo: async () => sourceInfo })
  const res = responseRecorder()
  await handler({ body: { history: 'all' } }, res, error => { throw error })
  assert.ok(res.body.data.history.length > 50)
  assert.equal(res.body.data.history[0].releaseNotes, 'Canonical current notes')
  assert.ok(res.body.data.history.some(item => item.version === '1.0.1'))
  assert.equal(sourceInfo.history.length, 1)
})

test('worker heartbeat ignores builders outside the retained allowlist', async () => {
  let touched = false
  let queried = false
  const handler = postHandler('/api/worker/heartbeat', {
    touchWorker: async () => { touched = true },
    db: () => ({ query: async () => { queried = true; return [[]] } }),
  })
  const res = responseRecorder()

  await handler({ body: { workerId: 'retired-worker' } }, res)

  assert.deepEqual(res.body, {
    success: true,
    data: { ignored: true, workerId: 'retired-worker' },
  })
  assert.equal(touched, false)
  assert.equal(queried, false)
})

test('platform publish route rejects a supplier delegated build', async () => {
  let started = false
  const handler = publishHandler({
    findBuildById: async () => ({ id: 'center-build', centerSupplierId: 'supplier-demo', status: 'succeeded' }),
    startReleaseBuild: async () => { started = true },
  })
  const res = responseRecorder()

  await handler({ params: { id: 'center-build' }, user: { id: 'admin' } }, res)

  assert.equal(res.statusCode, 403)
  assert.match(res.body.error, /供应商代构建任务/)
  assert.equal(started, false)
})

test('platform publish route still accepts a direct platform build', async () => {
  const directBuild = { id: 'direct-build', centerSupplierId: '', status: 'succeeded' }
  const handler = publishHandler({
    findBuildById: async () => directBuild,
    startReleaseBuild: async (build) => ({ ...build, releaseStatus: 'publishing' }),
  })
  const res = responseRecorder()

  await handler({ params: { id: 'direct-build' }, user: { id: 'admin' } }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.data.releaseStatus, 'publishing')
})

test('supplier project reservation route forwards the authenticated supplier and complete project list', async () => {
  let received = null
  const handler = postHandler('/api/center/projects/reserve', {
    reserveCenterSupplierProject: async (...args) => {
      received = args
      return { usedProjects: 4, maxProjects: 5 }
    },
  })
  const supplier = { id: 'supplier-demo' }
  const projectIds = ['project-a', 'project-b', 'project-c']
  const res = responseRecorder()

  await handler({ centerSupplier: supplier, body: { projectId: 'project-d', projectIds } }, res)

  assert.deepEqual(received, [supplier, 'project-d', projectIds])
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.usedProjects, 4)
})

test('supplier retry refreshes the center brand before requeuing an existing remote build', async () => {
  let centerPayload = null
  const current = { id: 'local-build', projectId: 'demo', status: 'failed', remoteBuildId: 'remote-build', centerSupplierId: '' }
  const project = { id: 'demo', ownerUserId: 'owner' }
  const handler = postHandler('/api/builds/:id/retry', {
    findBuildById: async () => current,
    findProjectById: async () => project,
    getBuildCenterConfig: async () => ({ enabled: true }),
    resetBuildForRetry: async () => ({ ...current, status: 'queued', log: '' }),
    prepareBuildCenterBrand: async () => ({ clientApiUrl: 'https://ai.example.com' }),
    buildCenterApi: async (_path, payload) => {
      centerPayload = payload
      return { id: 'remote-build', status: 'queued' }
    },
    updateBuild: async (_id, patch) => ({ ...current, ...patch }),
  })
  const res = responseRecorder()

  await handler({
    params: { id: current.id },
    body: {},
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    user: { id: 'owner', role: 'admin' },
  }, res, (err) => { throw err })

  assert.equal(res.statusCode, 200)
  assert.equal(centerPayload.brand.clientApiUrl, 'https://ai.example.com')
})

test('center retry stores a refreshed submitted brand while preserving center identity', async () => {
  let retryPatch = null
  const current = {
    id: 'remote-build',
    projectId: 'center-project',
    status: 'failed',
    centerSupplierId: 'supplier-demo',
    centerLocalBuildId: 'local-build',
    brand: {
      aiProjectId: 'demo',
      sourceSupplierId: 'supplier-demo',
      sourceProjectId: 'demo',
      sourceBuildId: 'local-build',
      centerProjectId: 'center-project',
      clientApiUrl: 'http://ai.example.com',
    },
    log: '',
  }
  const handler = postHandler('/api/center/builds/:id/retry', {
    findBuildById: async () => current,
    resetBuildForRetry: async (_id, patch) => {
      retryPatch = patch
      return { ...current, ...patch, status: 'queued' }
    },
  })
  const res = responseRecorder()

  await handler({
    params: { id: current.id },
    centerSupplier: { id: 'supplier-demo' },
    body: { brand: { aiProjectId: 'demo', clientApiUrl: 'https://ai.example.com', sourceSupplierId: 'spoofed', loginDesign: 'editorial', loginBackgroundUrl: 'retired' } },
  }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(retryPatch.brand.clientApiUrl, 'https://ai.example.com')
  assert.equal(retryPatch.brand.sourceSupplierId, 'supplier-demo')
  assert.equal(retryPatch.brand.sourceBuildId, 'local-build')
  assert.equal(retryPatch.brand.aiProjectId, 'center-project')
  assert.equal(retryPatch.brand.loginDesign, 'editorial')
  assert.equal(retryPatch.brand.loginBackgroundUrl, undefined)
})

test('center retry rejects invalid login themes before changing a build', async () => {
  let writes = 0
  const handler = postHandler('/api/center/builds/:id/retry', {
    findBuildById: async () => ({ id: 'remote-build', centerSupplierId: 'supplier-demo', status: 'failed' }),
    resetBuildForRetry: async () => { writes++; return {} },
  })
  const res = responseRecorder()
  await handler({ params: { id: 'remote-build' }, centerSupplier: { id: 'supplier-demo' }, body: { brand: { loginDesign: 'untrusted' } } }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(writes, 0)
})

test('central build operations stay inside the signed organization and admission confirms both quotas', async () => {
  for (const suffix of ['retry', 'publish', 'artifacts/cleanup']) {
    let writes = 0
    const handler = postHandler(`/api/center/builds/:id/${suffix}`, {
      findBuildById: async () => ({ id: 'remote', centerSupplierId: 'supplier-demo', organizationId: 'other-child', status: 'failed' }),
      resetBuildForRetry: async () => { writes++ }, releaseBuild: async () => { writes++ }, cleanupBuildArtifacts: async () => { writes++ },
    })
    const res = responseRecorder()
    await handler({ params: { id: 'remote' }, centerSupplier: { id: 'supplier-demo' }, centralAuthorization: { sub: 'child' }, body: {} }, res)
    assert.equal(res.statusCode, 404); assert.equal(writes, 0)
  }
  const actions = []
  const handler = postHandler('/api/center/builds', {
    officialResources: async (_req, input) => { actions.push(input); return { reservationId: 'quota-proof' } },
    createCenterBuild: async () => { assert.equal(actions.length, 3); return { id: 'remote' } },
  })
  const res = responseRecorder()
  await handler({ centralAuthorization: { sub: 'child' }, centerSupplier: { id: 'supplier-demo' }, body: { localBuildId: 'local-build', brand: { aiProjectId: 'project-one' } } }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(actions, [{ kind: 'projects', resourceId: 'project-one' }, { kind: 'builds', resourceId: 'local-build' }, { action: 'confirm', kind: 'builds', resourceId: 'local-build', reservationId: 'quota-proof' }])
})
