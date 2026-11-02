const labels = { package_published: '创建套餐配置', package_created: '创建套餐', package_updated: '修改套餐', package_deleted: '删除套餐', grant_issued: '签发代理授权', grant_updated: '修改代理授权', grant_deleted: '删除代理授权', code_reissued: '重发激活码', activated: '激活代理授权', instance_rotated: '迁移部署并轮换凭据', migration_completed: '结束部署迁移', resource_reserved: '占用项目或构建额度', operator_login: '运营账号登录' }
export function presentAudit(row, state) {
  const detail = row.detail || {}, grant = state.grants[row.target]
  const pkg = Object.values(state.packages).find(p => p.id === row.target || `${p.id}:${p.version}` === row.target)
  const eventLabel = row.event === 'grant_updated' && detail.beforeStatus && detail.beforeStatus !== detail.afterStatus ? ({ enabled: '启用代理授权', suspended: '停用代理授权', revoked: '撤销代理授权' }[detail.afterStatus] || '修改代理授权') : labels[row.event] || '其他系统操作'
  const targetLabel = grant?.name || detail.name || pkg?.name || (row.event === 'operator_login' ? '授权中心' : row.event === 'resource_reserved' ? (detail.kind === 'builds' ? '构建任务' : '品牌项目') : '历史记录')
  let description = eventLabel
  if (row.event === 'package_updated') description = `保存套餐配置，已同步更新${detail.affectedGrants || 0}个授权；已有用量保留`
  if (row.event === 'package_deleted') description = '已从可选套餐中删除，历史授权和审计记录保留'
  if (row.event === 'grant_updated') description = '已保存授权的状态、服务商模式、套餐或期限调整'
  if (row.event === 'grant_deleted') description = '授权已撤销并从列表移除，经营数据和历史记录保留'
  if (row.event === 'operator_login') description = row.loginMode === 'captcha' ? '通过账号、密码和图片验证码登录' : '通过账号、密码和动态验证码登录'
  if (row.event === 'resource_reserved') description = detail.kind === 'builds' ? '受理构建任务并占用累计构建额度' : '创建项目并占用项目额度'
  return { ...row, eventLabel, targetLabel, actorLabel: state.grants[row.actor]?.name || row.actor || '系统', description }
}
