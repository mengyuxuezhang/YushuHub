export const bearer = req => String(req.headers.authorization || '').replace(/^Bearer /, '')
export const endpoint = operation => async (req, res, next) => {
  try { res.json({ success: true, data: await operation(req) }) } catch (error) { next(error) }
}
export function registerLicenseCenterRoutes(app, { center, operators, notifications }) {
  const base = '/api/license-center/v1'
  app.post(`${base}/operator/login`, endpoint(req => operators.login(req.body, req.ip)))
  app.post(`${base}/operator/logout`, endpoint(req => operators.logout(bearer(req))))
  app.use(`${base}/operator`, async (req, res, next) => {
    try { req.operator = await operators.authenticate(bearer(req)); next() } catch (error) { next(error) }
  })
  app.get(`${base}/operator/state`, endpoint(() => center.list()))
  app.post(`${base}/operator/packages`, endpoint(req => center.publishPackage(req.body, req.operator)))
  app.post(`${base}/operator/grants`, endpoint(req => center.issue(req.body, req.operator)))
  app.post(`${base}/operator/legacy-imports/preview`, endpoint(req => center.previewLegacyImport(req.body)))
  app.post(`${base}/operator/legacy-imports`, endpoint(req => center.importLegacy(req.body, req.operator)))
  app.post(`${base}/operator/legacy-imports/:id/receipt`, endpoint(req => center.legacyImportReceipt(req.params.id)))
  app.post(`${base}/operator/grants/:id/preview`, endpoint(req => center.preview(req.params.id, req.body)))
  app.patch(`${base}/operator/grants/:id`, endpoint(req => center.update(req.params.id, req.body, req.operator)))
  app.post(`${base}/operator/grants/:id/code`, endpoint(req => center.reissueCode(req.params.id, req.operator)))
  app.post(`${base}/operator/grants/:id/rotate`, endpoint(req => center.rotate(req.params.id, req.body, req.operator)))
  app.post(`${base}/operator/grants/:id/migration/complete`, endpoint(req => center.completeMigration(req.params.id, req.body, req.operator)))
  app.post(`${base}/operator/reminders`, endpoint(() => center.reminders()))
  if (notifications) {
    app.get(`${base}/operator/notifications`, endpoint(() => notifications.state()))
    app.put(`${base}/operator/notifications/config`, endpoint(req => notifications.configure(req.body, req.operator)))
    app.post(`${base}/operator/notifications/test`, endpoint(req => notifications.test(req.body.requestId, req.operator)))
    app.post(`${base}/operator/notifications/scan`, endpoint(() => notifications.tick()))
  }
  app.post(`${base}/activate`, endpoint(req => center.activate(req.body, bearer(req))))
  app.post(`${base}/refresh`, endpoint(req => center.refresh(bearer(req))))
  app.post(`${base}/service-token`, endpoint(req => center.serviceToken(bearer(req), req.body.audience, req.body.organizationId, req.body.subjectHash)))
  app.post(`${base}/recovery-token`, endpoint(req => center.recoveryToken(bearer(req), req.body.organizationId, req.body.requestId)))
  app.post(`${base}/voice-maintenance-token`, endpoint(req => center.voiceMaintenanceToken(bearer(req), req.body.organizationId, req.body.modelId, req.body.subjectHash)))
  // Introspection verifies a short-lived signed token; it does not trust caller-supplied claims.
  app.post(`${base}/introspect`, endpoint(req => center.introspect(bearer(req), req.body.audience)))
  app.post(`${base}/resources/reserve`, endpoint(req => center.resource(bearer(req), { ...req.body, action: 'reserve' })))
  app.post(`${base}/resources/release`, endpoint(req => center.resource(bearer(req), req.body, true)))
  for (const action of ['status', 'confirm', 'cancel']) app.post(`${base}/resources/${action}`, endpoint(req => center.resource(bearer(req), { ...req.body, action })))
}
