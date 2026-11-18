import multer from 'multer'
import { fileURLToPath } from 'node:url'
import { requireAuth, requireAdmin, requirePermission, requireClientAuth } from '../middleware/auth.mjs'
import { buildCuratedPluginPackage, readCuratedPluginZip, maxPluginArchiveBytes, pluginIdPattern, pluginVersionPattern } from '../services/curated-plugin-package.mjs'
import { pluginMarket } from '../repositories/plugin-market.mjs'
import { clientProjectPolicy } from '../services/client-project-policy.mjs'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxPluginArchiveBytes, files: 1, fields: 0, parts: 2 } }).single('package')
const bundled = new Set(['github', 'feishu', 'wecom', 'dingtalk'])
const projectPattern = /^[a-z0-9][a-z0-9_-]{1,63}$/
const installationPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const valid = (pattern, value) => typeof value === 'string' && pattern.test(value)
const endpoint = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next)
const ok = (res, data) => res.json({ success: true, data })
const fail = (res, status, error) => res.status(status).json({ success: false, error })

export function registerPluginMarketRoutes(app, market = pluginMarket, policy = clientProjectPolicy) {
  const admin = '/api/plugin-market'
  const client = '/api/client/plugin-market'
  app.use([admin, client], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  const adminGate = [requireAuth, requireAdmin, requirePermission('plugin_market.manage')]
  const clientGate = [requireClientAuth, async (req, res, next) => {
    const projectId = req.get('x-agent-project-id')
    if (!valid(projectPattern, projectId)) return fail(res, 403, '客户端项目无效')
    try {
      await policy.assertAccess(projectId, req.clientUser)
      req.pluginProjectId = projectId
      next()
    } catch {
      fail(res, 403, '该账号未获项目访问授权')
    }
  }]
  async function publish(req, res, loadPackage) {
    let data
    try { data = await loadPackage() }
    catch { return fail(res, 400, '插件包格式无效，请校验原生清单、市场信息及技能文件') }
    if (!(await market.publish(data, req.user.id))) return fail(res, 409, '同一版本已发布，请提高版本号后重试')
    return ok(res, { ...data.plugin, sha256: data.sha256, size: data.bytes.length })
  }
  app.get(admin, ...adminGate, endpoint(async (_req, res) => ok(res, await market.overview())))
  app.post(admin + '/versions', ...adminGate, (req, res, next) => {
    upload(req, res, error => error ? fail(res, 400, '请选择有效的插件 ZIP 文件') : next())
  }, endpoint((req, res) => publish(req, res, () => readCuratedPluginZip(req.file?.buffer))))
  app.post(admin + '/bundled/:id', ...adminGate, endpoint((req, res) => {
    if (!bundled.has(req.params.id)) return fail(res, 404, '插件不存在')
    return publish(req, res, () => buildCuratedPluginPackage(fileURLToPath(new URL('../../resources/curated-plugins/' + req.params.id, import.meta.url))))
  }))
  app.put(admin + '/grants/:project/:id', ...adminGate, endpoint(async (req, res) => {
    const { project, id } = req.params
    const version = req.body?.version
    if (!valid(projectPattern, project) || !valid(pluginIdPattern, id) || !valid(pluginVersionPattern, version)) return fail(res, 400, '请选择有效的项目及插件版本')
    if (!(await market.grant(project, id, version, req.user.id))) return fail(res, 404, '项目或插件版本不可用')
    return ok(res, { enabled: true })
  }))
  app.delete(admin + '/grants/:project/:id', ...adminGate, endpoint(async (req, res) => {
    const { project, id } = req.params
    if (!valid(projectPattern, project) || !valid(pluginIdPattern, id)) return fail(res, 400, '项目或插件无效')
    await market.revoke(project, id)
    return ok(res, { enabled: false })
  }))
  app.get(client, ...clientGate, endpoint(async (req, res) => ok(res, await market.catalog(req.pluginProjectId))))
  app.get(client + '/:id/:version/package', ...clientGate, endpoint(async (req, res) => {
    const { id, version } = req.params
    if (!valid(pluginIdPattern, id) || !valid(pluginVersionPattern, version)) return fail(res, 404, '插件版本不可用')
    const bytes = await market.download(req.pluginProjectId, id, version)
    if (!bytes) return fail(res, 404, '插件版本未授权或已下架')
    res.type('application/zip').send(bytes)
  }))
  app.post(client + '/:id/:version/installation', ...clientGate, endpoint(async (req, res) => {
    const { id, version } = req.params
    const { installationId, state } = req.body || {}
    if (!valid(pluginIdPattern, id) || !valid(pluginVersionPattern, version) || !valid(installationPattern, installationId)
      || !['installed', 'removed'].includes(state)) return fail(res, 400, '安装回报无效')
    if (!(await market.report(req.pluginProjectId, req.clientUser.id, installationId, id, version, state))) return fail(res, 403, '插件版本不可用')
    return ok(res, { accepted: true })
  }))
}
