// Opt-in deployment overlay. Ordinary test/production instances do not load it.
export function demoAccountGuard(req, res, next) {
  const path = String(req.path || '').replace(/\/+$/, '').toLowerCase()
  const id = String(req.body?.id || '').trim().toLowerCase()
  const username = String(req.body?.username || '').trim().toLowerCase()
  const blocked = (req.method === 'POST' && path === '/api/me/password')
    || (req.method === 'POST' && path === '/api/users' && (id === 'admin' || username === 'admin123'))
    || (req.method === 'DELETE' && /^\/api\/users\/admin(?:\/delete)?$/i.test(path))
    || (req.method === 'POST' && /^\/api\/self-update\/(apply|config)$/i.test(path))
  if (blocked) return res.status(403).json({ success: false, code: 'DEMO_ADMIN_LOCKED', error: '演示站管理员账号固定为 admin123，不能修改密码、停用或删除；升级由维护人员执行。' })
  next()
}
