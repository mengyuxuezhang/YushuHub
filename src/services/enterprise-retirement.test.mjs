import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const source = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

test('enterprise product routes, permissions and modules remain retired', () => {
  const server = source('cloud/ai-admin/server.mjs')
  const permissions = source('src/config/constants.mjs')
  const navigation = source('web-admin/src/router/navigation.ts')
  assert.doesNotMatch(server, /registerEnterpriseBusinessRoutes|enterprise-workspace/)
  assert.doesNotMatch(permissions, /enterprise_(customers|members|quotas|usage|audit|features)/)
  assert.doesNotMatch(navigation, /\/enterprise|enterprise_/)
  assert.equal(existsSync(new URL('../routes/enterprise-business.mjs', import.meta.url)), false)
})

test('organization creation and project editing do not expose business modes', () => {
  const organizationDrawer = source('web-admin/src/components/organizations/OrganizationDrawer.vue')
  const projectDrawer = source('web-admin/src/components/delivery/ProjectDrawer.vue')
  assert.doesNotMatch(organizationDrawer, /businessMode|业务模式|企业主体/)
  assert.doesNotMatch(projectDrawer, /企业客户端|clientMode/)
})
