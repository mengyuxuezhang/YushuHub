const baseUrl = String(process.env.ORG_TEST_BASE_URL || 'http://127.0.0.1:7077').replace(/\/$/, '')
const adminUser = process.env.ORG_TEST_ADMIN_USER || process.env.AI_ADMIN_USER || 'admin'
const adminPassword = process.env.ORG_TEST_ADMIN_PASSWORD || process.env.AI_ADMIN_PASSWORD || ''
const childUser = process.env.ORG_TEST_CHILD_USER || ''
const childPassword = process.env.ORG_TEST_CHILD_PASSWORD || ''

async function login(username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const data = await response.json()
  if (!response.ok || !data.success) throw new Error(`登录失败 ${username}: ${data.error || response.status}`)
  return { data: data.data, cookie: String(response.headers.get('set-cookie') || '').split(';')[0] }
}

async function get(pathname, cookie) {
  const response = await fetch(`${baseUrl}${pathname}`, { headers: { cookie } })
  const data = await response.json()
  return { status: response.status, data }
}

const admin = await login(adminUser, adminPassword)
const child = childUser ? await login(childUser, childPassword) : null
const adminProjects = await get('/api/projects', admin.cookie)
const result = {
  admin: {
    level: admin.data.organizationContext?.organizationLevel,
    dataScope: admin.data.organizationContext?.dataScope,
    accessibleOrganizationIds: admin.data.organizationContext?.accessibleOrganizationIds,
    projectCount: adminProjects.data.data?.length || 0,
  },
}

if (child) {
  const childProjects = await get('/api/projects', child.cookie)
  const childUsers = await get('/api/users', child.cookie)
  const childContext = child.data.organizationContext
  result.child = {
    level: childContext?.organizationLevel,
    dataScope: childContext?.dataScope,
    accessibleOrganizationIds: childContext?.accessibleOrganizationIds,
    permissionKeys: child.data.permissionKeys,
    projectCount: childProjects.data.data?.length || 0,
    projectsStayInOrganization: (childProjects.data.data || []).every((project) => project.organizationId === childContext.organizationId),
    usersEndpointStatus: childUsers.status,
  }
  if (result.child.level !== 2 || result.child.dataScope !== 'self' || !result.child.projectsStayInOrganization) process.exitCode = 1
}

console.log(JSON.stringify(result, null, 2))
