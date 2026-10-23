import test from 'node:test'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import { UserUsageReportRepository, buildReportFacts } from './user-usage-report.mjs'
import { createUserUsageReportService, normalizeReportQuery } from '../services/user-usage-report.mjs'
import { migrateUserUsagePermissions } from '../services/user-usage-permissions.mjs'

// Use an isolated disposable database only. Never point this fixture at application data.
test('MySQL report aggregation, isolation, deduplication, units and EXPLAIN', { skip: !process.env.TEST_USAGE_MYSQL_URL }, async () => {
  const pool = mysql.createPool(process.env.TEST_USAGE_MYSQL_URL)
  try {
    const [[database]] = await pool.query('SELECT DATABASE() AS name')
    assert.equal(database.name, 'usage_report_test', 'fixture requires dedicated usage_report_test database')
    const definitions = {
      ai_end_users: 'id VARCHAR(64) PRIMARY KEY, username VARCHAR(190), display_name VARCHAR(190), email VARCHAR(190), organization_id VARCHAR(64), source_agent_id VARCHAR(64), source_project_id VARCHAR(64)',
      ai_projects: 'id VARCHAR(64) PRIMARY KEY, app_name VARCHAR(190), owner_user_id VARCHAR(64)',
      ai_organizations: 'id VARCHAR(64) PRIMARY KEY, name VARCHAR(190)',
      ai_credit_ledger: "id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),request_id VARCHAR(64),created_at DATETIME(3),change_type VARCHAR(32),deduct_status VARCHAR(32),points_delta DECIMAL(24,8),prompt_tokens INT DEFAULT 0,completion_tokens INT DEFAULT 0,total_tokens INT DEFAULT 0,raw_usage_json JSON,model_name VARCHAR(120) DEFAULT '',billing_type VARCHAR(32) DEFAULT '',KEY idx_ledger_usage_request(user_id,request_id,id),KEY idx_ledger_usage_date(user_id,change_type,created_at),KEY idx_ledger_usage_period(change_type,created_at)",
      ai_model_operations: 'id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),capability_id VARCHAR(64),task_type VARCHAR(48),operation_type VARCHAR(48),status VARCHAR(32),usage_json JSON',
      ai_model_task_capabilities: 'id VARCHAR(64) PRIMARY KEY,provider_model_id VARCHAR(64)',
      ai_provider_models: 'id VARCHAR(64) PRIMARY KEY,model_id VARCHAR(120),model_type VARCHAR(32),organization_id VARCHAR(64)',
      ai_voice_operations: 'id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),voice_id VARCHAR(64),status VARCHAR(32),operation_type VARCHAR(48),result_json JSON',
      ai_private_voices: 'id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),provider_model_id VARCHAR(64)',
      ai_system_voices: 'id VARCHAR(64) PRIMARY KEY,organization_id VARCHAR(64),provider_model_id VARCHAR(64)',
    }
    for (const [name, columns] of Object.entries(definitions)) {
      await pool.query(`DROP TABLE IF EXISTS ${name}`)
      await pool.query(`CREATE TABLE IF NOT EXISTS ${name} (${columns}) DEFAULT CHARSET=utf8mb4`)
      await pool.query(`ALTER TABLE ${name} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      await pool.query(`DELETE FROM ${name}`)
    }
    await pool.query("INSERT INTO ai_organizations VALUES ('a','A'),('b','B')")
    await pool.query("INSERT INTO ai_projects VALUES ('p','项目','owner')")
    await pool.query("INSERT INTO ai_end_users VALUES ('u','=FORMULA','使用用户','u@a','a','owner','p'),('zero','zero','零使用','zero@a','a','','p'),('foreign','foreign','外部用户','f@b','b','','')")
    await pool.query("INSERT INTO ai_provider_models VALUES ('im','image-model','image','a')")
    await pool.query("INSERT INTO ai_model_task_capabilities VALUES ('ic','im')")
    await pool.query("INSERT INTO ai_model_operations VALUES ('image','u','ic','image_generation','generate','succeeded',?),('failed','u','ic','image_generation','generate','failed',NULL)", [JSON.stringify([{meter:'image',quantity:2,phase:'usage'}])])
    await pool.query("INSERT INTO ai_voice_operations VALUES ('voice','u','','succeeded','synthesize',?)", [JSON.stringify({characters:20,durationSec:1.5})])
    const ledger = async (id, request, date, points, usage, extras = {}) => {
      await pool.query(`INSERT INTO ai_credit_ledger (id,user_id,request_id,created_at,change_type,deduct_status,points_delta,raw_usage_json,model_name,billing_type)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [id,extras.user || 'u',request,date,extras.change || 'consume',extras.status || 'succeeded',points,usage == null ? null : JSON.stringify(usage),extras.model || 'text-model',extras.billing || 'per_token'])
    }
    await ledger('01','text','2026-10-01 00:00:00',-3,{prompt_tokens:10,completion_tokens:4,cached_tokens:0})
    await ledger('02','text','2026-10-01 00:00:00',-3,{prompt_tokens:10,completion_tokens:4})
    await ledger('03','free','2026-10-02 23:59:59.999',0,{input_tokens:0,output_tokens:0,cached_tokens:0})
    await ledger('04','image','2026-10-02 12:00:00',-2,null,{model:'image-model'})
    await ledger('05','voice','2026-10-02 12:00:00',-1,null,{billing:'voice'})
    await ledger('06','missing','2026-10-02 12:00:00',0,null,{status:'missing_usage'})
    await ledger('07','failed','2026-10-02 12:00:00',-99,null)
    await ledger('08','recharge','2026-10-02 12:00:00',100,null,{change:'recharge'})
    await ledger('09','outside','2026-10-03 00:00:00',-1,null)
    await ledger('10','foreign','2026-10-02 12:00:00',-99,null,{user:'foreign'})
    await ledger('11','before','2026-09-30 23:59:59.999',-1,null)
    await pool.query("INSERT INTO ai_model_operations VALUES ('cached','u','ic','chat','chat','succeeded',?)", [JSON.stringify([{meter:'input_tokens',quantity:8},{meter:'cached_tokens',quantity:2},{meter:'output_tokens',quantity:3}])])
    await ledger('12','cached','2026-10-02 12:00:00',0,null)
    const actor = { id:'owner',organizationContext:{organizationId:'a',organizationLevel:1,dataScope:'self',accessibleOrganizationIds:['a'],legacyOwnerUserId:'owner'} }
    const repo = new UserUsageReportRepository(pool), service = createUserUsageReportService(repo)
    const input = {startDate:'2026-10-01',endDate:'2026-10-02'}
    const overview = await service.overview(actor,input)
    assert.equal(overview.summary.requests,6)
    assert.equal(overview.summary.points,6)
    assert.equal(overview.summary.users,1)
    assert.equal(overview.summary.inputTokens,null)
    assert.equal(overview.summary.images,2)
    assert.equal(overview.summary.audioCharacters,20)
    assert.equal(overview.summary.audioSeconds,1.5)
    assert.equal(overview.trend.reduce((sum,x)=>sum+x.requests,0),6)
    const users = await service.users(actor,input)
    assert.equal(users.total,2)
    assert.equal(users.items[0].activeDays,2)
    assert.equal(users.items[0].lastUsedAt,'2026-10-03 00:00:00.000')
    assert.equal(users.items[1].requests,0)
    assert.equal(users.items[1].inputTokens,0)
    assert.equal((await service.users(actor,{...input,type:'image'})).total,1)
    assert.equal((await service.users(actor,{...input,model:'image-model'})).items[0].images,2)
    assert.equal((await service.users(actor,{...input,projectId:'unrelated'})).total,0)
    assert.equal((await service.users(actor,{...input,search:'zero'})).items[0].requests,0)
    for(const sort of ['requests','lastUsed']) assert.equal((await service.users(actor,{...input,sort})).items[0].userId,'u')
    assert.equal((await service.users(actor,{...input,pageSize:1,page:2})).items[0].userId,'zero')
    const detail = await service.detail(actor,'u',input)
    assert.equal(detail.calls.total,overview.summary.requests)
    assert.equal(detail.models.reduce((sum,x)=>sum+x.points,0),overview.summary.points)
    assert.equal(detail.calls.items.find(x=>x.requestId==='cached').inputTokens,10)
    await assert.rejects(service.detail(actor,'foreign',input),{statusCode:404})
    const csv = await service.export(actor,input)
    assert.ok(!csv.includes('foreign'))
    assert.match(csv,/'=FORMULA/)
    assert.match(csv,/"6","2","6"/)
    const q = normalizeReportQuery(input), facts = buildReportFacts(actor,q)
    const plan = await repo.rows(`EXPLAIN SELECT COUNT(*) FROM (${facts.sql}) f`,facts.params)
    assert.ok(plan.some(row=>row.table==='d' && row.possible_keys?.includes('idx_ledger_usage_request')))
    console.log('MySQL EXPLAIN:', JSON.stringify(plan.filter(row=>['l','d','u'].includes(row.table)).map(({table,type,key,rows,Extra})=>({table,type,key,rows,Extra}))))
    await pool.query('CREATE TABLE IF NOT EXISTS ai_feature_migrations (migration_key VARCHAR(120) PRIMARY KEY)')
    await pool.query('CREATE TABLE IF NOT EXISTS ai_role_templates (id VARCHAR(64) PRIMARY KEY,system_builtin INT)')
    await pool.query('CREATE TABLE IF NOT EXISTS ai_role_template_permissions (template_id VARCHAR(64),permission_key VARCHAR(120),PRIMARY KEY(template_id,permission_key))')
    await pool.query('CREATE TABLE IF NOT EXISTS ai_organization_capabilities (organization_id VARCHAR(64),capability_key VARCHAR(120),enabled INT,transferable INT,limit_value INT,granted_by_organization_id VARCHAR(64),granted_by_user_id VARCHAR(64),PRIMARY KEY(organization_id,capability_key))')
    for(const table of ['ai_feature_migrations','ai_role_templates','ai_role_template_permissions','ai_organization_capabilities']) await pool.query(`DELETE FROM ${table}`)
    await pool.query("INSERT INTO ai_role_templates VALUES ('operations',1),('custom',0)")
    await pool.query("INSERT INTO ai_role_template_permissions VALUES ('operations','credits.manage'),('custom','credits.manage')")
    await pool.query("INSERT INTO ai_organization_capabilities VALUES ('a','credits.manage',1,1,0,'a','system'),('b','credits.manage',0,0,0,'a','system')")
    await migrateUserUsagePermissions(pool)
    const [granted]=await pool.query("SELECT * FROM ai_role_template_permissions WHERE permission_key='user_usage.view'")
    assert.equal(granted.length,1)
    const [[denied]]=await pool.query("SELECT enabled FROM ai_organization_capabilities WHERE organization_id='b' AND capability_key='user_usage.view'")
    assert.equal(denied.enabled,0)
    await pool.query("DELETE FROM ai_role_template_permissions WHERE permission_key LIKE 'user_usage.%'")
    await pool.query("DELETE FROM ai_organization_capabilities WHERE capability_key LIKE 'user_usage.%'")
    await migrateUserUsagePermissions(pool)
    assert.equal((await pool.query("SELECT * FROM ai_role_template_permissions WHERE permission_key LIKE 'user_usage.%'"))[0].length,0)
    assert.equal((await pool.query("SELECT * FROM ai_organization_capabilities WHERE capability_key LIKE 'user_usage.%'"))[0].length,0)
  } finally { await pool.end() }
})
