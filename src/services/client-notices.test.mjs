import test from 'node:test'
import assert from 'node:assert/strict'
import { setPool } from '../db/pool.mjs'
import { listClientNotices, normalizeNoticeInput, publishNotice } from './client-notices.mjs'
import { centerNoticeFeed, syncNoticeDirectory } from './client-notice-federation.mjs'

const actor = {
  id: 'operator-a',
  organizationContext: {
    organizationId: 'org-a', accessibleOrganizationIds: ['org-a'], legacyOwnerUserId: 'owner-a', dataScope: 'self',
  },
}
const notice = { id: 'notice-1', organization_id: 'org-a', status: 'draft', target_type: 'all', target_ids: '[]', expires_at: null }

function publishPool(row, userRows = []) {
  const queries = []
  const connection = {
    beginTransaction: async () => { queries.push('BEGIN') },
    commit: async () => { queries.push('COMMIT') },
    rollback: async () => { queries.push('ROLLBACK') },
    release: () => {},
    query: async (sql, params) => {
      queries.push({ sql, params })
      if (sql.includes('FOR UPDATE')) return [[row]]
      if (sql.startsWith('SELECT u.id FROM ai_end_users')) return [userRows]
      if (sql.startsWith('SELECT p.id FROM ai_projects')) return [[]]
      if (sql.startsWith('SELECT id FROM ai_organizations')) return [[{ id: 'org-a' }]]
      if (sql.startsWith('INSERT INTO ai_client_notice_recipients')) return [{ affectedRows: 2 }]
      if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 2 }]]
      return [{ affectedRows: 1 }]
    },
  }
  setPool({ getConnection: async () => connection, query: connection.query })
  return queries
}

test('normalizes only supported content, targets and HTTP(S) links', () => {
  const base = { category: 'notice', title: '标题', summary: '摘要', body: '正文', targetType: 'all' }
  assert.equal(normalizeNoticeInput({ ...base, actionUrl: 'https://example.com/info' }).actionUrl, 'https://example.com/info')
  assert.equal(normalizeNoticeInput({ ...base, actionUrl: 'http://example.com/info' }).actionUrl, 'http://example.com/info')
  assert.throws(() => normalizeNoticeInput({ ...base, actionUrl: 'javascript:alert(1)' }), /HTTP\(S\)/)
  assert.throws(() => normalizeNoticeInput({ ...base, targetType: 'users', targetIds: ['../other'] }), /ID/)
  assert.throws(() => normalizeNoticeInput({ ...base, targetType: 'users', targetIds: [] }), /请选择/)
})

test('publishing snapshots only the actor-accessible users', async () => {
  const queries = publishPool(notice)
  const result = await publishNotice(actor, notice.id)
  assert.equal(result.recipientCount, 2)
  const insertion = queries.find((entry) => entry.sql?.startsWith('INSERT INTO ai_client_notice_recipients'))
  assert.match(insertion.sql, /u\.organization_id IN/)
  assert.match(insertion.sql, /u\.status='enabled'/)
  assert.deepEqual(insertion.params.slice(0, 2), ['notice-1', 'org-a'])
  assert.ok(queries.includes('COMMIT'))
})

test('selected user outside scope is rejected before any recipient insert', async () => {
  const queries = publishPool({ ...notice, target_type: 'users', target_ids: '["other-user"]' }, [])
  await assert.rejects(publishNotice(actor, notice.id), (error) => error.statusCode === 403)
  assert.ok(queries.includes('ROLLBACK'))
  assert.equal(queries.some((entry) => entry.sql?.startsWith('INSERT INTO ai_client_notice_recipients')), false)
})

test('selected organization outside scope is rejected', async () => {
  const queries = publishPool({ ...notice, target_type: 'organization', target_ids: '["org-b"]' })
  await assert.rejects(publishNotice(actor, notice.id), (error) => error.statusCode === 403)
  assert.ok(queries.includes('ROLLBACK'))
})

test('selected project must resolve inside the sender scope before snapshot', async () => {
  const queries = publishPool({ ...notice, target_type: 'project', target_ids: '["project-b"]' })
  await assert.rejects(publishNotice(actor, notice.id), (error) => error.statusCode === 403)
  assert.equal(queries.some((entry) => entry.sql?.startsWith('INSERT INTO ai_client_notice_recipients')), false)
})

test('client response does not reveal recipient IDs or target organization', async () => {
  setPool({ query: async (sql) => {
    if (sql.includes('SELECT COUNT(*)')) return [[{ total: 1 }]]
    return [[{ ...notice, status: 'published', category: 'activity', title: '活动', summary: '说明', body: '详情', action_label: '', action_url: '', target_ids: '["user-a","user-b"]', published_at: new Date(), read_at: null, dismissed_at: null }]]
  } })
  const result = await listClientNotices('user-a')
  assert.equal(result.items.length, 1)
  assert.equal('targetIds' in result.items[0], false)
  assert.equal('organizationId' in result.items[0], false)
})

test('center snapshots a selected downstream user without local-user leakage', async () => {
  const queries = []
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql, params) => {
      queries.push({ sql, params })
      if (sql.includes('FOR UPDATE')) return [[{ ...notice, target_type: 'users', target_ids: '["supplier-a~user-b"]' }]]
      if (sql.startsWith('SELECT EXISTS(')) return [[{ found: 1 }]]
      if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 0 }]]
      if (sql.startsWith('INSERT INTO ai_client_notice_remote_recipients')) return [{ affectedRows: 1 }]
      return [{ affectedRows: 0 }]
    },
  }
  setPool({ getConnection: async () => connection, query: connection.query })
  const result = await publishNotice({ id: 'root', organizationContext: { organizationId: 'platform', dataScope: 'platform' } }, notice.id)
  assert.equal(result.recipientCount, 1)
  const remoteInsert = queries.find((entry) => entry.sql.startsWith('INSERT INTO ai_client_notice_remote_recipients'))
  assert.deepEqual(remoteInsert.params, ['notice-1', 'supplier-a', 'user-b'])
  assert.match(queries.find((entry) => entry.sql.startsWith('INSERT INTO ai_client_notice_recipients')).sql, /0=1/)
})

test('agent cannot target another supplier by encoded user ID', async () => {
  const queries = publishPool({ ...notice, target_type: 'users', target_ids: '["supplier-b~user-c"]' })
  await assert.rejects(publishNotice(actor, notice.id), (error) => error.statusCode === 403)
  assert.ok(queries.includes('ROLLBACK'))
})

test('directory sync stamps the authenticated supplier scope and retires stale entries', async () => {
  const queries = []
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql, params) => { queries.push({ sql, params }); return [{ affectedRows: 1 }] },
  }
  setPool({ getConnection: async () => connection })
  const result = await syncNoticeDirectory('supplier-a', { generation: 'sync-a', final: true, users: [{ id: 'user-a', username: 'a', displayName: 'A', organizationId: 'forged-other-org', projectId: 'project-a', createdAt: '2026-01-01T00:00:00Z' }] })
  assert.equal(result.accepted, 1)
  assert.equal(queries[0].params[4], 'supplier-a')
  assert.deepEqual(queries[1].params, ['supplier-a', 'sync-a'])
})

test('center feed uses a bounded watermark and supplier-scoped incremental query', async () => {
  const queries = []
  setPool({ query: async (sql, params) => {
    queries.push({ sql, params })
    if (sql.startsWith('SELECT CURRENT_TIMESTAMP')) return [[{ watermark: new Date('2026-09-24T10:00:00Z') }]]
    return [[]]
  } })
  const result = await centerNoticeFeed('supplier-a', { page: 1, since: '2026-09-24T09:00:00Z' })
  assert.equal(result.watermark, '2026-09-24T10:00:00.000Z')
  assert.match(queries[1].sql, /r\.supplier_id=\?/)
  assert.match(queries[1].sql, /n\.updated_at>\?/)
  assert.equal(queries[1].params[0], 'supplier-a')
  assert.equal(result.hasMore, false)
})
