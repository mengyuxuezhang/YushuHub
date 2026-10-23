import { registerAuthRoutes } from '../src/routes/auth.mjs'
import { registerRedeemCodeRoutes } from '../src/routes/redeem-codes.mjs'
import { registerSystemRoutes } from '../src/routes/platform-settings.mjs'
import { registerClientApiRoutes } from '../src/routes/client-api.mjs'
import { registerMembershipRoutes } from '../src/routes/memberships.mjs'
import { registerPaymentRoutes } from '../src/routes/payments.mjs'
import { registerModelServiceRoutes } from '../src/routes/model-service.mjs'
import { registerUserRoutes } from '../src/routes/users.mjs'
import { registerAdminBusinessRoutes } from '../src/routes/admin-business.mjs'
import { registerBuildRoutes } from '../src/routes/builds.mjs'
import { registerCuratedSkillRoutes } from '../src/routes/curated-skills.mjs'
import { registerCuratedMcpRoutes } from '../src/routes/curated-mcps.mjs'
import { registerCuratedAgentRoutes } from '../src/routes/curated-agents.mjs'
import { registerOrganizationRoutes } from '../src/routes/organizations.mjs'
import { registerCustomHomepageRoutes } from '../src/routes/custom-homepage.mjs'

const registrations = [
  ['auth', registerAuthRoutes],
  ['redeem-codes', registerRedeemCodeRoutes],
  ['platform-settings', registerSystemRoutes],
  ['client-api', registerClientApiRoutes],
  ['memberships', registerMembershipRoutes],
  ['payments', registerPaymentRoutes],
  ['model-service', registerModelServiceRoutes],
  ['users', registerUserRoutes],
  ['admin-business', registerAdminBusinessRoutes],
  ['builds', registerBuildRoutes],
  ['curated-skills', registerCuratedSkillRoutes],
  ['curated-mcps', registerCuratedMcpRoutes],
  ['curated-agents', registerCuratedAgentRoutes],
  ['organizations', registerOrganizationRoutes],
  ['custom-homepage', registerCustomHomepageRoutes],
]

let passed = 0
let failed = 0

for (const [name, fn] of registrations) {
  if (typeof fn === 'function') {
    console.log(`PASS: ${name} exports register function`)
    passed++
  } else {
    console.log(`FAIL: ${name} does not export a function (got ${typeof fn})`)
    failed++
  }
}

const mockApp = {
  _routes: [],
  get(path, ...handlers) { this._routes.push(['GET', path]) },
  post(path, ...handlers) { this._routes.push(['POST', path]) },
  put(path, ...handlers) { this._routes.push(['PUT', path]) },
  patch(path, ...handlers) { this._routes.push(['PATCH', path]) },
  delete(path, ...handlers) { this._routes.push(['DELETE', path]) },
  use(path, ...handlers) { this._routes.push(['USE', path]) },
}

const noop = () => {}
const noopAsync = async () => {}
const mockDeps = new Proxy({}, { get: () => noop })

try {
  registerAuthRoutes(mockApp, mockDeps)
  console.log(`PASS: auth registered ${mockApp._routes.length} routes`)
  passed++
} catch (err) {
  console.log(`FAIL: auth registration error: ${err.message}`)
  failed++
}

try {
  registerRedeemCodeRoutes(mockApp)
  console.log(`PASS: redeem-codes registered`)
  passed++
} catch (err) {
  console.log(`FAIL: redeem-codes registration error: ${err.message}`)
  failed++
}

const routeModules = [
  ['platform-settings', registerSystemRoutes],
  ['client-api', registerClientApiRoutes],
  ['memberships', registerMembershipRoutes],
  ['payments', registerPaymentRoutes],
  ['model-service', registerModelServiceRoutes],
  ['users', registerUserRoutes],
  ['admin-business', registerAdminBusinessRoutes],
  ['builds', registerBuildRoutes],
  ['curated-skills', registerCuratedSkillRoutes],
  ['curated-mcps', registerCuratedMcpRoutes],
  ['curated-agents', registerCuratedAgentRoutes],
  ['organizations', registerOrganizationRoutes],
  ['custom-homepage', registerCustomHomepageRoutes],
]

for (const [name, fn] of routeModules) {
  const app = { _routes: [], get(p){this._routes.push(p)}, post(p){this._routes.push(p)}, put(p){this._routes.push(p)}, patch(p){this._routes.push(p)}, delete(p){this._routes.push(p)}, use(p){this._routes.push(p)} }
  try {
    fn(app, mockDeps)
    console.log(`PASS: ${name} registered ${app._routes.length} route handlers`)
    passed++
  } catch (err) {
    console.log(`FAIL: ${name} registration error: ${err.message}`)
    failed++
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
