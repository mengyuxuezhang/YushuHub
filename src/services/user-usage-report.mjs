const DAY = 86400000
export const REPORT_METRICS = ['inputTokens', 'outputTokens', 'cachedTokens', 'images', 'audioCharacters', 'audioSeconds']
export const REPORT_TYPES = ['text', 'image', 'audio', 'search', 'vector', 'video', 'other']
export const REPORT_NOTES = [
  '使用次数为已完成的模型请求，不等于聊天次数或任务数；免费调用也计入。',
  '活跃天数为期间有使用记录的北京时间日期数。最后使用时间为全历史口径。',
  '历史缺失计量显示未记录，各类用量使用独立单位，不包含充值、调整及兑换。',
  '数据仅涵盖本实例已保存的调用记录，不包含登录、在线时长或其他服务器数据。',
]
export function reportError(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }) }
export function beijingDate(now = new Date()) { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10) }
function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw reportError('请选择有效日期')
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw reportError('请选择有效日期')
  return date.getTime()
}
export function normalizeReportQuery(input = {}, now = new Date()) {
  const endDate = String(input.endDate || beijingDate(now))
  const end = dateValue(endDate)
  const startDate = String(input.startDate || new Date(end - 29 * DAY).toISOString().slice(0, 10))
  const start = dateValue(startDate)
  if (start > end || (end - start) / DAY + 1 > 366) throw reportError('日期范围应为 1 至 366 天')
  const type = String(input.type || '')
  if (type && !REPORT_TYPES.includes(type)) throw reportError('使用类型无效')
  const sort = String(input.sort || 'points')
  if (!['points', 'requests', 'lastUsed'].includes(sort)) throw reportError('排序方式无效')
  const integer = (value, fallback, max) => {
    const n = Number(value ?? fallback)
    if (!Number.isInteger(n) || n < 1 || n > max) throw reportError('分页参数无效')
    return n
  }
  return { startDate, endDate, start: `${startDate} 00:00:00`, end: `${new Date(end + DAY).toISOString().slice(0, 10)} 00:00:00`,
    search: String(input.search || '').trim().slice(0, 190), projectId: String(input.projectId || '').slice(0, 80),
    model: String(input.model || '').slice(0, 120), userId: String(input.userId || '').slice(0, 64), type, sort,
    page: integer(input.page, 1, 1000000), pageSize: integer(input.pageSize, 20, 100) }
}
export function publicReportFilters(q) {
  return { startDate: q.startDate, endDate: q.endDate, timezone: 'Asia/Shanghai', search: q.search,
    projectId: q.projectId, model: q.model, type: q.type, userId: q.userId, sort: q.sort }
}
export function csvCell(value) {
  let text = value == null ? '未记录' : String(value)
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
export function reportCsv(rows, filters, generatedAt = new Date()) {
  const fields = ['username', 'displayName', 'organizationName', 'projectName', 'requests', 'activeDays', 'points', ...REPORT_METRICS, 'lastUsedAt']
  const headers = ['账号', '姓名', '组织', '项目', '使用次数', '活跃天数', '消耗积分', '输入 Token', '输出 Token', '缓存 Token', '图片张数', '语音字符', '语音秒数', '最后使用时间（全历史）']
  const line = (items) => items.map(csvCell).join(',')
  return '\uFEFF' + [line(['用户使用报表', '生成时间', generatedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })]),
    line(['筛选条件', JSON.stringify(publicReportFilters(filters))]), ...REPORT_NOTES.map(note => line(['统计口径', note])),
    line(headers), ...rows.map(row => line(fields.map(field => row[field])))].join('\r\n') + '\r\n'
}

export function createUserUsageReportService(repository) {
  const metadata = q => ({ filters: publicReportFilters(q), notes: REPORT_NOTES })
  return {
    async overview(actor, input) {
      const q = normalizeReportQuery(input)
      const summary = await repository.overview(actor, q)
      const points = await repository.trend(actor, q)
      const indexed = new Map(points.map(item => [item.date, item]))
      const trend = []
      for (let day = dateValue(q.startDate); day < dateValue(q.endDate) + DAY; day += DAY) {
        const date = new Date(day).toISOString().slice(0, 10)
        trend.push(indexed.get(date) || { date, users: 0, requests: 0, points: 0 })
      }
      return { ...metadata(q), summary, trend }
    },
    async users(actor, input) {
      const q = normalizeReportQuery(input)
      return { ...metadata(q), ...await repository.users(actor, q) }
    },
    async detail(actor, id, input) {
      const q = normalizeReportQuery({ ...input, userId: id })
      const user = await repository.visibleUser(actor, id)
      if (!user) throw reportError('用户不存在或不在授权范围内', 404)
      const [summary, models, calls] = await Promise.all([
        this.overview(actor, q), repository.models(actor, q), repository.calls(actor, q),
      ])
      return { ...metadata(q), user, summary: summary.summary, trend: summary.trend, models, calls }
    },
    async options(actor) { return repository.options(actor) },
    async export(actor, input) {
      const q = normalizeReportQuery(input)
      const data = await repository.users(actor, q, 50000)
      if (data.total > 50000) throw reportError('导出超过 50,000 行，请缩小筛选范围', 413)
      return reportCsv(data.items, q)
    },
  }
}
