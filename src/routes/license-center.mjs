export const bearer = req => String(req.headers.authorization || '').replace(/^Bearer /, '')
export const endpoint = operation => async (req, res, next) => { try { res.json({ success: true, data: await operation(req) }) } catch (e) { next(e) } }
export function registerLicenseCenterRoutes(app, { center, operators }) {
  const base = '/api/license-center/v1'
  app.post(`${base}/operator/login`, endpoint(req => operators.login(req.body, req.ip)))
  app.use(`${base}/operator`, async (req, _res, next) => { try { req.operator = await operators.authenticate(bearer(req)); next() } catch (e) { next(e) } })
  app.post(`${base}/operator/logout`, endpoint(req => operators.logout(bearer(req))))
  app.get(`${base}/operator/state`, endpoint(() => center.list()))
  app.post(`${base}/operator/packages`, endpoint(req => center.publishPackage(req.body, req.operator)))
  app.post(`${base}/operator/grants`, endpoint(req => center.issue(req.body, req.operator)))
  app.post(`${base}/operator/grants/:id/preview`, endpoint(req => center.preview(req.params.id, req.body)))
  app.patch(`${base}/operator/grants/:id`, endpoint(req => center.update(req.params.id, req.body, req.operator)))
  app.post(`${base}/operator/grants/:id/code`, endpoint(req => center.reissueCode(req.params.id, req.operator)))
  app.post(`${base}/operator/grants/:id/rotate`, endpoint(req => center.rotate(req.params.id, req.body, req.operator)))
  app.post(`${base}/operator/grants/:id/migration/complete`, endpoint(req => center.completeMigration(req.params.id, req.body, req.operator)))
  app.post(`${base}/operator/reminders`, endpoint(() => center.reminders()))
  app.post(`${base}/activate`, endpoint(req => center.activate(req.body)))
  app.post(`${base}/refresh`, endpoint(req => center.refresh(bearer(req))))
  app.post(`${base}/service-token`, endpoint(req => center.serviceToken(bearer(req), req.body.audience)))
  app.post(`${base}/introspect`, endpoint(req => center.introspect(bearer(req), req.body.audience)))
  app.post(`${base}/resources/usage`, endpoint(req => center.resourceUsage(bearer(req))))
  for (const action of ['reserve', 'confirm', 'cancel', 'status', 'release']) app.post(`${base}/resources/${action}`, endpoint(req => center.resource(bearer(req), { ...req.body, action })))
}
