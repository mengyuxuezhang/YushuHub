import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReportQuery, csvCell, createUserUsageReportService } from './user-usage-report.mjs'
import { reportUserScope } from '../repositories/user-usage-report.mjs'

test('Beijing defaults, exclusive end day, leap dates and bounded pagination', () => {
  const q = normalizeReportQuery({},new Date('2026-10-08T16:00:00Z'))
  assert.equal(q.startDate,'2026-09-10')
  assert.equal(q.end,'2026-10-10 00:00:00')
  assert.equal(q.pageSize,20)
  assert.equal(normalizeReportQuery({startDate:'2024-02-29',endDate:'2024-02-29'}).end,'2024-03-01 00:00:00')
  for (const input of [{startDate:'2026-02-29'}, {startDate:'2025-01-01',endDate:'2026-01-02'}, {pageSize:101}, {page:0}, {sort:'id; DROP'}, {type:'unknown'}]) assert.throws(()=>normalizeReportQuery(input))
  assert.doesNotThrow(()=>normalizeReportQuery({startDate:'2024-01-01',endDate:'2024-12-31'}))
})
test('CSV prevents formulas, quotes newlines and distinguishes unknown from zero', () => {
  for (const value of ['=SUM(A1)',' +1','-2','@x','\tformula','\rformula','\nformula']) assert.ok(csvCell(value).startsWith('"\''))
  assert.equal(csvCell(null),'"未记录"')
  assert.equal(csvCell(0),'"0"')
  assert.equal(csvCell('a"b\nc'),'"a""b\nc"')
})
test('organization scope denies unassigned actors and only explicit platform scope bypasses isolation', () => {
  assert.throws(()=>reportUserScope({id:'admin'}),{statusCode:403})
  const context={organizationId:'a',organizationLevel:1,dataScope:'platform',accessibleOrganizationIds:['a']}
  assert.notEqual(reportUserScope({id:'admin',organizationContext:context}).sql,'1=1')
  assert.equal(reportUserScope({id:'admin',organizationContext:{...context,organizationLevel:0}}).sql,'1=1')
  assert.ok(reportUserScope({id:'admin',organizationContext:context}).params.includes('a'))
  const children=reportUserScope({id:'admin',organizationContext:{...context,dataScope:'children',accessibleOrganizationIds:['child']}})
  assert.deepEqual(children.params,['child'])
  assert.ok(!children.sql.includes('source_agent_id'))
})
test('export cap is enforced before CSV generation; details check scope before querying usage', async () => {
  const service=createUserUsageReportService({async users(){return {total:50001,items:[]}},async visibleUser(){return null}})
  await assert.rejects(service.export({},{}),{statusCode:413})
  await assert.rejects(service.detail({},'foreign',{}),{statusCode:404})
})
