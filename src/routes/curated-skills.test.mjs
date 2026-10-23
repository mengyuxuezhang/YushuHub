import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'

import { DEFAULT_ROLE_TEMPLATES } from '../config/constants.mjs'
import { agentOwnsCuratedSkill, canDeleteCuratedSkill, isReservedDesktopCapabilitySkillId, registerCuratedSkillRoutes } from './curated-skills.mjs'
import { setPool } from '../db/pool.mjs'
import { PUBLIC_ADMIN_BASE_URL } from '../config/env.mjs'
import { publicMarketCatalogItems } from '../services/market-catalog-sync.mjs'

function skillRoutes(options = {}) {
  const routes = new Map()
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (path, ...handlers) => routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1))]))
  return { routes, ...registerCuratedSkillRoutes(app, { keyOwnerUserIdForEndUser: async () => '', ...options }) }
}

test('client and center package routes keep authorization gates and report missing files safely', async () => {
  let allowed = true
  const row = { id: 'distribution', skill_id: 'missing-download-regression', owner_user_id: 'owner',
    version: '1.0.0', skill_status: 'published', version_status: 'published', status: 'published',
    package_path: '/missing-curated-package-regression/package.zip',
    manifest_json: { encryptedPackageSha256: '0'.repeat(64) },
  }
  setPool({ async query(sql) {
    if (sql.startsWith('SELECT card_id') || sql.startsWith('SELECT audience_type')) return [[]]
    if (sql.startsWith('SELECT d.*') || sql.startsWith('SELECT s.*')) return [allowed ? [row] : []]
    if (sql.startsWith('SELECT * FROM ai_curated_skill_versions')) return [[row]]
    throw new Error(`Unexpected query: ${sql}`)
  } })
  const { routes } = skillRoutes({ keyOwnerUserIdForEndUser: async () => 'owner' })
  for (const endpoint of ['GET /api/client/skill-market/:skillId/versions/:version/package',
    'GET /api/center/curated-skills/:skillId/versions/:version/package',
    'POST /api/center/curated-skills/:skillId/versions/:version/package']) {
    for (const access of [false, true]) {
      allowed = access
      const response = { code: 200, headers: {}, status(code) { this.code = code; return this },
        setHeader(key, value) { this.headers[key] = value }, removeHeader(key) { delete this.headers[key] },
        json(body) { this.body = body; return this },
      }
      await routes.get(endpoint)({ clientUser: { id: 'user' }, centerSupplier: { id: 'supplier' },
        params: { skillId: row.skill_id, version: row.version }, headers: {},
      }, response, error => { throw error })
      assert.equal(response.code, access ? 404 : 403)
      assert.equal(response.body.success, false)
      assert.equal(response.headers['X-Agent-Skill-Manifest'], undefined)
      assert.ok(!JSON.stringify(response.body).includes('/missing-curated'))
    }
  }
})

test('list/detail and uninstall agree on session device without changing other installations', async () => {
  const hash = id => createHash('sha256').update(id).digest('hex')
  const row = { id:'distribution',skill_id:'skill-a',owner_user_id:'owner',name:'技能',version:'1.0.0',skill_status:'published',version_status:'published',selected_version_id:'v1' }
  const records = new Map([[`u:${hash('old')}`, 'installed'], [`u:${hash('current')}`, 'installed']])
  setPool({async query(sql, args) {
    if (sql.startsWith('SELECT card_id')) return [[]]
    if (sql.startsWith('SELECT audience_type')) return [[]]
    if (sql.startsWith('SELECT d.*')) {
      assert.ok(args.includes('owner'))
      assert.ok(!sql.includes('AS installed_version'))
      return [[row]]
    }
    if (sql.startsWith('SELECT i.skill_id')) {
      const [user,device,...ids]=args
      assert.match(sql,/i.end_user_id=\? AND i.device_id_hash=\?/)
      assert.deepEqual(ids,['skill-a'])
      return [records.get(`${user}:${device}`)==='installed' ? [{skill_id:'skill-a',version:'1.0.0'}] : []]
    }
    if (sql.startsWith('INSERT INTO ai_curated_skill_installations')) {
      records.set(`${args[5]}:${args[6]}`,args[7]); return [{affectedRows:1}]
    }
    throw new Error(`Unexpected query: ${sql}`)
  }})
  const {routes}=skillRoutes({keyOwnerUserIdForEndUser:async()=> 'owner'})
  const request={clientUser:{id:'u',sessionDeviceId:'current'},params:{skillId:'skill-a'},query:{deviceId:'old'}}
  const invoke=async (route, req=request) => {
    const res={code:200,status(code){this.code=code;return this},json(body){this.body=body;return this}}
    await routes.get(route)(req,res)
    return res
  }
  const check=async expected=>{
    assert.equal((await invoke('GET /api/client/skill-market')).body.data.items[0].installState,expected)
    assert.equal((await invoke('GET /api/client/skill-market/:skillId')).body.data.installState,expected)
  }
  await check('installed')
  assert.equal((await invoke('POST /api/client/skill-market/:skillId/installations',{...request,body:{deviceId:'old',status:'removed'}})).code,403)
  await check('installed')
  for(const status of ['removed','removed','installed','removed']) {
    assert.equal((await invoke('POST /api/client/skill-market/:skillId/installations',{...request,body:{deviceId:'current',status}})).body.data.status,status)
    await check(status==='installed'?'installed':'not_installed')
    assert.equal(records.get(`u:${hash('old')}`),'installed')
  }
  const other = {...request,clientUser:{id:'other-user',sessionDeviceId:'old'}}
  assert.equal((await invoke('GET /api/client/skill-market',other)).body.data.items[0].installState,'not_installed')
  const unbound={...request,clientUser:{id:'u'}}
  assert.equal((await invoke('GET /api/client/skill-market/:skillId',unbound)).body.data.installState,'not_installed')
})

test('agent operator can create, publish, distribute and delete its own curated skills', () => {
  const template = DEFAULT_ROLE_TEMPLATES.find((item) => item.id === 'agent-operator')
  assert.ok(template)
  for (const permission of ['curated_skills.view', 'curated_skills.manage', 'curated_skills.publish', 'curated_skills.distribute']) {
    assert.equal(template.permissionKeys.includes(permission), true, `missing ${permission}`)
  }
  const skill = { created_by: 'agent-a' }
  assert.equal(agentOwnsCuratedSkill(skill, { id: 'agent-a', role: 'agent' }), true)
  assert.equal(agentOwnsCuratedSkill(skill, { id: 'agent-b', role: 'agent' }), false)
  assert.equal(agentOwnsCuratedSkill(skill, { id: 'admin', role: 'admin' }), true)
})

test('retired video records can be cleaned but its Desktop capability ID stays reserved', () => {
  const admin = { id: 'admin', role: 'admin' }
  assert.equal(canDeleteCuratedSkill({ id: 'video-creation', created_by: 'admin', source_type: 'local' }, admin), true)
  assert.equal(isReservedDesktopCapabilitySkillId('video-creation'), true)
  assert.equal(isReservedDesktopCapabilitySkillId('custom-skill'), false)
  assert.equal(canDeleteCuratedSkill({ id: 'official-skill', created_by: 'official-center', source_type: 'official_sync' }, admin), true)
  assert.equal(canDeleteCuratedSkill({ id: 'official-skill', created_by: 'official-center', source_type: 'official_sync' }, { id: 'agent-a', role: 'agent' }), false)
  assert.equal(canDeleteCuratedSkill({ id: 'custom-skill', created_by: 'admin', source_type: 'local' }, admin), true)
  assert.equal(canDeleteCuratedSkill({ id: 'custom-skill', created_by: 'agent-a', source_type: 'local' }, admin), false)
})

test('market catalogs normalize uploaded images and preserve external URLs and cleared images', () => {
  for (const field of ['coverUrl', 'iconUrl']) {
    const catalog = [
      { id: 'relative', [field]: '/uploads/admin/market.png' },
      { id: 'external', [field]: 'https://cdn.example.com/market.png?rev=2' },
      { id: 'empty', [field]: '' },
      { id: 'null', [field]: null },
    ]
    assert.deepEqual(publicMarketCatalogItems(catalog, field, {}), [
      { id: 'relative', [field]: `${PUBLIC_ADMIN_BASE_URL}/uploads/admin/market.png` },
      catalog[1], catalog[2], { id: 'null', [field]: '' },
    ])
    assert.equal(catalog[0][field], '/uploads/admin/market.png')
  }
})

test('skill sync refreshes same-version covers without downloading or changing package distribution', async () => {
  const local = { id: 'official-skill', name: '技能', version: '1.0.0', current_version_id: 'version-id', status: 'published', source_type: 'official_sync', cover_url: '' }
  const remote = { id: local.id, name: local.name, version: local.version, coverUrl: '' }
  let failCoverWrite = false
  let downloads = 0
  setPool({ async query(sql, params) {
    if (sql.startsWith('SELECT s.id, s.name, s.status')) {
      assert.match(sql, /s.cover_url/)
      return [[{ ...local }]]
    }
    if (sql.startsWith('SELECT * FROM ai_curated_skills')) return [[{ ...local }]]
    if (sql.startsWith('SELECT * FROM ai_curated_skill_versions')) return [[{ id: local.current_version_id, version: local.version }]]
    if (sql.startsWith('SELECT id FROM ai_curated_skills')) return [[{ id: local.id }]]
    if (sql.startsWith('UPDATE ai_curated_skills SET cover_url=')) {
      if (failCoverWrite) throw new Error('cover write failed')
      assert.equal(params[1], local.id)
      local.cover_url = params[0]
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE ai_curated_skill_market_placements') || sql.startsWith('INSERT INTO ai_curated_skill_market_placements')) return [{ affectedRows: 1 }]
    // Package/version/distribution writes are not allowed for a cover-only update.
    throw new Error(`Unexpected query: ${sql}`)
  } })
  const { routes, syncCenterSkills } = skillRoutes({
    fetchCenterCatalog: async () => ({ items: [remote] }),
    fetchCenterPackage: async () => { downloads += 1; throw new Error('unexpected package download') },
  })
  const check = async () => {
    const res = { json(body) { this.body = body } }
    await routes.get('GET /api/curated-skill-sync/update-status')({}, res, (error) => { throw error })
    return res.body.data
  }
  let previousSignature
  for (const coverUrl of ['https://center.example/uploads/first.png', 'https://center.example/uploads/second.png', '']) {
    remote.coverUrl = coverUrl
    const status = await check()
    assert.equal(status.updateAvailable, true)
    assert.equal(status.updated, 1)
    assert.notEqual(status.signature, previousSignature)
    previousSignature = status.signature
    assert.deepEqual(await syncCenterSkills('admin'), { added: 0, updated: 1, removed: 0, skipped: 0, failed: [] })
    assert.equal(local.cover_url, coverUrl)
    assert.equal((await check()).updateAvailable, false)
    assert.equal((await syncCenterSkills('admin')).updated, 0)
  }
  remote.coverUrl = 'https://center.example/uploads/retry.png'
  failCoverWrite = true
  const failed = await syncCenterSkills('admin')
  assert.equal(failed.updated, 0)
  assert.deepEqual(failed.failed, [{ skillId: local.id, error: 'cover write failed' }])
  assert.equal(local.cover_url, '')
  failCoverWrite = false
  assert.equal((await syncCenterSkills('admin')).updated, 1)
  local.source_type = 'local'
  remote.coverUrl = ''
  assert.equal((await syncCenterSkills('admin')).skipped, 1)
  assert.equal(local.cover_url, 'https://center.example/uploads/retry.png')
  assert.equal(downloads, 0)
})
