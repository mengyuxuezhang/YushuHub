import assert from 'node:assert/strict'
import test from 'node:test'

import { audienceCovers, diffAgentCatalog, registerCuratedAgentRoutes } from './curated-agents.mjs'
import { DEFAULT_ROLE_TEMPLATES } from '../config/constants.mjs'
import { setPool } from '../db/pool.mjs'
import { PUBLIC_ADMIN_BASE_URL } from '../config/env.mjs'

function postRouteHandler(path) {
  return agentRoutes().routes.get(`POST ${path}`)
}

function agentRoutes(options = {}) {
  const routes = new Map()
  const app = {
    get(routePath, ...handlers) { routes.set(`GET ${routePath}`, handlers.at(-1)) },
    post(routePath, ...handlers) { routes.set(`POST ${routePath}`, handlers.at(-1)) },
    put(routePath, ...handlers) { routes.set(`PUT ${routePath}`, handlers.at(-1)) },
    patch(routePath, ...handlers) { routes.set(`PATCH ${routePath}`, handlers.at(-1)) },
    delete(routePath, ...handlers) { routes.set(`DELETE ${routePath}`, handlers.at(-1)) },
  }
  const sync = registerCuratedAgentRoutes(app, { keyOwnerUserIdForEndUser: async () => '', ...options })
  return { routes, ...sync }
}

test('creating an agent with an existing owned ID returns a readable conflict', async () => {
  const queries = []
  let rolledBack = false
  let released = false
  const connection = {
    async beginTransaction() {},
    async query(sql) {
      queries.push(sql)
      if (sql.startsWith('SELECT id,owner_user_id FROM ai_curated_agents')) return [[{ id: 'dadfas', owner_user_id: 'owner-a' }], []]
      throw new Error(`Unexpected query: ${sql}`)
    },
    async rollback() { rolledBack = true },
    release() { released = true },
  }
  setPool({ async getConnection() { return connection } })
  const handler = postRouteHandler('/api/curated-agents')
  let captured
  await handler({
    body: { id: 'dadfas', name: '测试智能体', description: '用途', prompt: '指令', version: '1.0.0' },
    ownerUserId: 'owner-a', actorUserId: 'actor-a',
  }, {}, (error) => { captured = error })

  assert.equal(captured?.statusCode, 409)
  assert.equal(captured?.code, 'CURATED_AGENT_ID_EXISTS')
  assert.match(captured?.message || '', /已存在.*列表.*编辑/)
  assert.equal(queries.some((sql) => sql.startsWith('INSERT INTO ai_curated_agents')), false)
  assert.equal(rolledBack, true)
  assert.equal(released, true)
})

test('creating an agent writes complete market metadata and commits atomically', async () => {
  const placementParams = []
  let committed = false
  let rolledBack = false
  let released = false
  const row = {
    id: 'market-agent', name: '市场智能体', description: '市场用途', prompt: '执行指令', icon_url: 'https://example.com/icon.png',
    publisher_name: '内容团队', profile_labels_json: ['专家'], usage_label: '100 次使用', expertise_tags_json: ['内容运营'], starter_prompts_json: ['帮我规划一周内容'],
    version: '1.0.0', permission_mode: 'default', status: 'draft', source_type: 'local', source_agent_id: '', created_by: 'actor-a',
  }
  const connection = {
    async beginTransaction() {},
    async query(sql, params) {
      if (sql.startsWith('SELECT id,owner_user_id FROM ai_curated_agents')) return [[], []]
      if (sql.startsWith('INSERT INTO ai_curated_agents')) return [{ affectedRows: 1 }, []]
      if (sql.startsWith('DELETE FROM ai_curated_agent_dependencies')) return [{ affectedRows: 0 }, []]
      if (sql.startsWith('SELECT name,description,icon_url FROM ai_curated_agents')) return [[row], []]
      if (sql.startsWith('UPDATE ai_curated_agent_market_placements')) return [{ affectedRows: 0 }, []]
      if (sql.includes('INSERT INTO ai_curated_agent_market_placements')) { placementParams.push(params); return [{ affectedRows: 1 }, []] }
      if (sql.startsWith('SELECT * FROM ai_curated_agents')) return [[row], []]
      if (sql.startsWith('SELECT dependency_type,dependency_id,required')) return [[], []]
      if (sql.startsWith('SELECT market_type,status FROM ai_curated_agent_market_placements')) return [[{ market_type: 'personal', status: 'draft' }], []]
      throw new Error(`Unexpected query: ${sql}`)
    },
    async commit() { committed = true },
    async rollback() { rolledBack = true },
    release() { released = true },
  }
  setPool({ async getConnection() { return connection } })
  const handler = postRouteHandler('/api/curated-agents')
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
  let captured

  await handler({
    body: { id: row.id, name: row.name, description: row.description, prompt: row.prompt, iconUrl: row.icon_url, publisherName: row.publisher_name, profileLabels: row.profile_labels_json, usageLabel: row.usage_label, expertiseTags: row.expertise_tags_json, starterPrompts: row.starter_prompts_json, version: row.version, marketTypes: ['personal'] },
    ownerUserId: 'owner-a', actorUserId: 'actor-a',
  }, res, (error) => { captured = error })

  assert.equal(captured, undefined)
  assert.equal(res.statusCode, 201)
  assert.deepEqual(res.body.data.marketTypes, ['personal'])
  assert.deepEqual(res.body.data.starterPrompts, ['帮我规划一周内容'])
  assert.equal(placementParams.length, 1)
  for (const params of placementParams) assert.deepEqual(params.slice(3, 6), [row.name, row.description, row.icon_url])
  assert.equal(committed, true)
  assert.equal(rolledBack, false)
  assert.equal(released, true)
})

test('creating an agent rolls back when market placement persistence fails', async () => {
  let committed = false
  let rolledBack = false
  const connection = {
    async beginTransaction() {},
    async query(sql) {
      if (sql.startsWith('SELECT id,owner_user_id FROM ai_curated_agents')) return [[], []]
      if (sql.startsWith('INSERT INTO ai_curated_agents')) return [{ affectedRows: 1 }, []]
      if (sql.startsWith('DELETE FROM ai_curated_agent_dependencies')) return [{ affectedRows: 0 }, []]
      if (sql.startsWith('SELECT name,description,icon_url FROM ai_curated_agents')) return [[{ name: '失败智能体', description: '用途', icon_url: null }], []]
      if (sql.startsWith('UPDATE ai_curated_agent_market_placements')) return [{ affectedRows: 0 }, []]
      if (sql.includes('INSERT INTO ai_curated_agent_market_placements')) throw Object.assign(new Error('market write failed'), { code: 'ER_NO_DEFAULT_FOR_FIELD' })
      throw new Error(`Unexpected query: ${sql}`)
    },
    async commit() { committed = true },
    async rollback() { rolledBack = true },
    release() {},
  }
  setPool({ async getConnection() { return connection } })
  const handler = postRouteHandler('/api/curated-agents')
  let captured

  await handler({ body: { id: 'failed-agent', name: '失败智能体', description: '用途', prompt: '指令' }, ownerUserId: 'owner-a', actorUserId: 'actor-a' }, {}, (error) => { captured = error })

  assert.equal(captured?.code, 'ER_NO_DEFAULT_FOR_FIELD')
  assert.equal(committed, false)
  assert.equal(rolledBack, true)
})

test('agent distribution permissions are available to supplier roles', () => {
  for (const template of DEFAULT_ROLE_TEMPLATES.filter((item) => ['supplier-admin', 'agent-operator'].includes(item.id))) {
    for (const permission of ['curated_agents.view', 'curated_agents.manage', 'curated_agents.publish', 'curated_agents.distribute']) assert.equal(template.permissionKeys.includes(permission), true)
  }
})

test('all-users agent distribution requires all-users dependency permission', () => {
  assert.equal(audienceCovers([{ type: 'all', id: '' }], [{ type: 'all', id: '' }]), true)
  assert.equal(audienceCovers([{ type: 'membership_card', id: 'vip' }], [{ type: 'all', id: '' }]), false)
})

test('membership agent distribution must be a subset of dependency permission', () => {
  assert.equal(audienceCovers([{ type: 'membership_card', id: 'vip' }, { type: 'membership_card', id: 'pro' }], [{ type: 'membership_card', id: 'vip' }]), true)
  assert.equal(audienceCovers([{ type: 'membership_card', id: 'vip' }], [{ type: 'membership_card', id: 'pro' }]), false)
})

test('official agent catalog identifies additions, updates and removals', () => {
  const diff = diffAgentCatalog(
    [{ id: 'new-agent', version: '1.0.0' }, { id: 'updated-agent', version: '2.0.0' }],
    [{ id: 'updated-agent', version: '1.0.0', status: 'published' }, { id: 'removed-agent', version: '1.0.0', status: 'published' }],
  )
  assert.deepEqual(diff.added.map((item) => item.id), ['new-agent'])
  assert.deepEqual(diff.updated.map((item) => item.id), ['updated-agent'])
  assert.deepEqual(diff.removed.map((item) => item.id), ['removed-agent'])
})

test('official agent catalog detects presentation-only changes', () => {
  const diff = diffAgentCatalog(
    [{ id: 'expert', version: '1.0.0', publisherName: '新发布者', profileLabels: ['专家'], expertiseTags: ['运营'], starterPrompts: ['帮我写选题'] }],
    [{ id: 'expert', version: '1.0.0', status: 'published', publisher_name: '旧发布者', profile_labels_json: '["专家"]', expertise_tags_json: '["运营"]', starter_prompts_json: '["帮我写选题"]' }],
  )
  assert.deepEqual(diff.updated.map((item) => item.id), ['expert'])
})

test('center agent catalog exports upload icons with the publishing Admin origin', async () => {
  setPool({ async query(sql) {
    if (sql.startsWith('SELECT * FROM ai_curated_agents')) return [[{ id: 'official-agent', icon_url: '/uploads/admin/agent.png' }]]
    if (sql.startsWith('SELECT dependency_type') || sql.startsWith('SELECT market_type')) return [[]]
    throw new Error(`Unexpected query: ${sql}`)
  } })
  const { routes } = agentRoutes({ centerMode: true })
  const res = { setHeader() {}, json(body) { this.body = body } }
  await routes.get('POST /api/center/curated-agents/catalog')({}, res, (error) => { throw error })
  assert.equal(res.body.data.items[0].iconUrl, `${PUBLIC_ADMIN_BASE_URL}/uploads/admin/agent.png`)
})

test('agent sync detects and persists icon-only updates without a version bump', async () => {
  let local = { id: 'official-agent', name: '专家', description: '说明', prompt: '指令', version: '1.0.0', status: 'published', source_type: 'official_sync', icon_url: '' }
  const remote = { id: local.id, name: local.name, description: local.description, prompt: local.prompt, version: local.version, iconUrl: '' }
  const placements = []
  setPool({ async query(sql, params) {
    if (sql.startsWith('SELECT id,name,version,status')) {
      assert.match(sql, /icon_url/)
      return [[{ ...local }]]
    }
    if (sql.startsWith('SELECT * FROM ai_curated_agents')) return [[{ ...local }]]
    if (sql.startsWith('SELECT name,description,icon_url')) return [[local]]
    if (sql.startsWith('SELECT id FROM ai_curated_agents')) return [[{ id: local.id }]]
    if (sql.startsWith('INSERT INTO ai_curated_agents')) { local.icon_url = params[4]; return [{ affectedRows: 1 }] }
    if (sql.includes('INSERT INTO ai_curated_agent_market_placements')) { placements.push(params[5]); return [{ affectedRows: 1 }] }
    if (sql.startsWith('DELETE FROM ai_curated_agent_dependencies') || sql.startsWith('UPDATE ai_curated_agent_')) return [{ affectedRows: 1 }]
    throw new Error(`Unexpected query: ${sql}`)
  } })
  const { routes, syncCenterAgents } = agentRoutes({ fetchCenterCatalog: async () => ({ items: [remote] }) })
  const check = async () => {
    const res = { json(body) { this.body = body } }
    await routes.get('GET /api/curated-agent-sync/update-status')({}, res, (error) => { throw error })
    return res.body.data
  }
  let previousSignature
  for (const iconUrl of ['https://center.example/uploads/first.png', 'https://center.example/uploads/second.png', '']) {
    remote.iconUrl = iconUrl
    const status = await check()
    assert.equal(status.updateAvailable, true)
    assert.equal(status.updated, 1)
    assert.notEqual(status.signature, previousSignature)
    previousSignature = status.signature
    const result = await syncCenterAgents()
    assert.deepEqual(result, { added: 0, updated: 1, removed: 0, skipped: 0, failed: [] })
    assert.equal(local.icon_url, iconUrl)
    assert.equal(placements.at(-1), iconUrl || null)
    assert.equal((await check()).updateAvailable, false)
    assert.equal((await syncCenterAgents()).updated, 0)
  }
  local.source_type = 'local'
  remote.iconUrl = 'https://center.example/uploads/other.png'
  assert.equal((await syncCenterAgents()).skipped, 1)
  assert.equal(local.icon_url, '')
})
