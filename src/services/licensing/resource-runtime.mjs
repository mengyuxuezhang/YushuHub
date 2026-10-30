import { mysqlStateStore } from '../../repositories/licensing-state.mjs'
import { digest, failure, identifier } from './protocol.mjs'
import crypto from 'node:crypto'

export function buildResourceIdentity(project, requestedBy, version, key) {
  if (key !== undefined && key !== null) { identifier(key, '构建请求ID'); if (key.length > 80) throw failure('INVALID_ID', '构建请求ID不能超过80字符') }
  return { id: key ? digest(`${project.organizationId}:${key}`).slice(0, 36) : crypto.randomUUID(), fingerprint: digest(JSON.stringify([project.id, requestedBy, version])) }
}
export async function lockBuildProject(connection, project) {
  const [[locked]] = await connection.query('SELECT organization_id FROM ai_projects WHERE id=? FOR UPDATE', [project.id])
  if (!locked || locked.organization_id !== project.organizationId) throw failure('BUILD_SCOPE_CHANGED', '项目归属已经变化，请刷新后重试', 409)
  const [[active]] = await connection.query("SELECT * FROM ai_builds WHERE project_id=? AND status IN ('queued','running') LIMIT 1", [project.id])
  return active || null
}
export async function assertProjectUserRetention(connection, id) {
  const [[users]] = await connection.query('SELECT COUNT(*) AS count FROM ai_end_users WHERE source_project_id=?', [id])
  if (Number(users.count) > 0) throw failure('PROJECT_HAS_USERS', '项目已有终端用户，请先停用项目并保留用户权益及账务记录', 409)
}

export const emptyResourceIntents = () => ({ intents: {} })
// Low-frequency resource coordination uses a separate non-monetary aggregate.
// The final business write and its local intent commit in the same transaction.
export function createResourceCoordinator({ store, remote, resolveOrganization, exists, readBuild }) {
  let chain = Promise.resolve()
  let flushing = false
  const serial = work => { const next = chain.then(work); chain = next.catch(() => {}); return next }
  async function subject(organizationId) {
    const organization = await resolveOrganization(organizationId)
    if (!organization) throw failure('RESOURCE_SCOPE_MISSING', '资源缺少可信组织归属', 403)
    return { localId: identifier(organizationId), grantId: organization.externalId || (organization.agentLevel === 2 ? organization.id : undefined) }
  }
  async function accept(kind, resourceId, organizationId, fingerprint, work) {
    identifier(resourceId)
    const owner = await subject(organizationId), key = `${kind}:${resourceId}`
    await store.transaction(state => {
      const old = state.intents[key]
      if (old && (old.organizationId !== owner.localId || (kind === 'builds' && old.fingerprint !== fingerprint))) throw failure('RESOURCE_OWNER_CONFLICT', '资源编号已绑定其他组织或请求', 409)
      if (old && ['preparing', 'active', 'confirming'].includes(old.state)) return
      if (old && kind === 'builds') throw failure('RESOURCE_CANCELLED', '原构建未受理，请使用新的提交编号', 409)
      if (old?.state === 'releasing') throw failure('RESOURCE_RELEASE_PENDING', '原项目额度尚在释放，请稍后重建', 409)
      state.intents[key] = { key, kind, resourceId, organizationId: owner.localId, grantId: owner.grantId, fingerprint, state: 'preparing', updatedAt: Date.now() }
    })
    let result
    try { result = await store.transaction(async (state, connection) => {
      const intent = state.intents[key]
      if (!['preparing', 'active', 'confirming'].includes(intent.state)) throw failure('RESOURCE_CANCELLED', '资源操作已经取消', 409)
      if (kind === 'builds' && await exists(kind, resourceId, connection)) return readBuild(resourceId, connection)
      const occupied = await remote('reserve', kind, resourceId, owner.grantId, { provisional: kind === 'builds' })
      intent.reservationId = occupied.reservationId
      const value = await work(connection)
      intent.state = 'active'
      if (kind === 'builds') intent.state = value?.id && value.id !== resourceId ? 'aborting' : 'confirming'
      intent.updatedAt = Date.now()
      return value
    }) } catch (error) {
      await store.transaction(state => {
        const intent = state.intents[key]
        if (intent?.state === 'preparing') { intent.state = 'aborting'; intent.error = error.code || 'RESOURCE_ACCEPT_FAILED'; intent.updatedAt = Date.now() }
      })
      throw error
    }
    if (kind === 'builds') await reconcile(key).catch(() => {}) // Durable retry; never refund an accepted job.
    return result
  }
  async function reconcile(key) {
    return store.transaction(async (state, connection) => {
      const intent = state.intents[key]
      if (!intent || ['active', 'released', 'cancelled'].includes(intent.state)) return
      if (intent.state === 'preparing' && intent.updatedAt > Date.now() - 300_000) return
      const present = await exists(intent.kind, intent.resourceId, connection)
      if (present) {
        if (intent.state === 'releasing') throw failure('RESOURCE_DELETE_UNCONFIRMED', '本地资源仍存在，禁止释放额度', 409)
        const reserved = await remote('reserve', intent.kind, intent.resourceId, intent.grantId, { provisional: intent.kind === 'builds' })
        intent.reservationId = reserved.reservationId
        if (intent.kind === 'builds') await remote('confirm', intent.kind, intent.resourceId, intent.grantId, { reservationId: intent.reservationId })
        intent.state = 'active'
      } else {
        const reserved = await remote('status', intent.kind, intent.resourceId, intent.grantId)
        if (reserved) await remote(intent.kind === 'builds' ? 'cancel' : 'release', intent.kind, intent.resourceId, intent.grantId, { reservationId: reserved.reservationId })
        intent.state = intent.kind === 'builds' ? 'cancelled' : 'released'
      }
      intent.updatedAt = Date.now(); delete intent.error
    })
  }
  return {
    project: (id, organizationId, work) => serial(() => accept('projects', id, organizationId, digest(id), work)),
    build: (id, organizationId, fingerprint, work) => serial(() => accept('builds', id, organizationId, fingerprint, work)),
    removeProject(id, organizationId, work) {
      return serial(async () => {
        const owner = await subject(organizationId), key = `projects:${identifier(id)}`
        const result = await store.transaction(async (state, connection) => {
          const intent = state.intents[key]
          if (intent && intent.organizationId !== owner.localId) throw failure('RESOURCE_OWNER_CONFLICT', '项目不属于当前组织', 403)
          const value = await work(connection)
          state.intents[key] = { ...(intent || {}), key, kind: 'projects', resourceId: id, organizationId: owner.localId, grantId: owner.grantId, state: 'releasing', updatedAt: Date.now() }
          return value
        })
        await reconcile(key).catch(() => {})
        return result
      })
    },
    async flush() {
      if (flushing) return
      flushing = true
      try { await serial(async () => {
      for (const intent of Object.values((await store.read()).intents).filter(item => !['active', 'released', 'cancelled'].includes(item.state)).slice(0, 50)) {
        try { await reconcile(intent.key) }
        catch (error) { await store.transaction(state => { const row = state.intents[intent.key]; row.error = error.code || 'RESOURCE_RETRY'; row.updatedAt = Date.now() }) }
      }
      }) } finally { flushing = false }
    },
    state: () => store.read(),
  }
}

export function resourceRuntime({ client, database, resolveOrganization, readBuild }) {
  if (!client) return null
  const pool = { query: (...args) => database().query(...args), getConnection: () => database().getConnection() }
  const store = mysqlStateStore(pool, 'local-resources-v1', emptyResourceIntents())
  const coordinator = createResourceCoordinator({ store, resolveOrganization, readBuild,
    remote: (...args) => client.resource(...args),
    exists: async (kind, id, connection) => {
      const [[row]] = await connection.query(`SELECT id FROM ${kind === 'projects' ? 'ai_projects' : 'ai_builds'} WHERE id=? LIMIT 1`, [id])
      return Boolean(row)
    } })
  let timer
  return { ...coordinator, async start() { await store.read(); timer = setInterval(() => coordinator.flush().catch(() => {}), 30_000); timer.unref(); await coordinator.flush() },
    stop() { clearInterval(timer) } }
}
