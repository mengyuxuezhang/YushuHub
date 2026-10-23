import { readFile } from 'node:fs/promises'

const baseUrl = String(process.env.CREDIT_TEST_BASE_URL || 'http://127.0.0.1:7467').replace(/\/$/, '')

async function loadEnvFile(file) {
  if (!file) return
  const text = await readFile(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || process.env[match[1]] !== undefined) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    process.env[match[1]] = value
  }
}

await loadEnvFile(process.env.CREDIT_TEST_ENV_FILE)

const username = process.env.CREDIT_TEST_ADMIN_USER || process.env.AI_ADMIN_USER || 'admin'
const password = process.env.CREDIT_TEST_ADMIN_PASSWORD || process.env.AI_ADMIN_PASSWORD || ''
if (!password) throw new Error('未提供管理后台测试密码')

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options)
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) throw new Error(`${options.method || 'GET'} ${pathname}: ${body.error || response.status}`)
  return { body, response }
}

const login = await request('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
})
const cookie = String(login.response.headers.get('set-cookie') || '').split(';')[0]
if (!cookie) throw new Error('登录成功但没有收到会话 Cookie')

const headers = { cookie, 'content-type': 'application/json' }
const listUsers = async () => (await request('/api/end-users?page=1&pageSize=100', { headers })).body.data
const beforePage = await listUsers()
const target = (beforePage.items || beforePage).find((item) => item.canOperate)
if (!target) throw new Error('没有可安全测试的终端用户')

const before = Number(target.creditBalance || 0)
const delta = 1
let added = false
let restored = false

try {
  const plus = await request(`/api/end-users/${encodeURIComponent(target.id)}/credits`, {
    method: 'POST', headers, body: JSON.stringify({ amount: delta, note: '自动化测试：加积分后立即恢复' }),
  })
  added = true
  const plusBalance = Number(plus.body.data.creditBalance)
  if (plusBalance !== before + delta) throw new Error(`加积分接口返回异常：${before} -> ${plusBalance}`)

  const afterPlusPage = await listUsers()
  const afterPlus = (afterPlusPage.items || afterPlusPage).find((item) => item.id === target.id)
  if (Number(afterPlus?.creditBalance) !== before + delta) throw new Error('终端用户列表没有返回调整后的 creditBalance')

  const minus = await request(`/api/end-users/${encodeURIComponent(target.id)}/credits`, {
    method: 'POST', headers, body: JSON.stringify({ amount: -delta, note: '自动化测试：恢复原积分' }),
  })
  restored = Number(minus.body.data.creditBalance) === before
  if (!restored) throw new Error(`扣积分后未恢复原值：期望 ${before}，实际 ${minus.body.data.creditBalance}`)
} finally {
  if (added && !restored) {
    const currentPage = await listUsers().catch(() => ({ items: [] }))
    const current = (currentPage.items || currentPage).find((item) => item.id === target.id)
    const correction = before - Number(current?.creditBalance ?? before)
    if (correction) {
      const recovery = await request(`/api/end-users/${encodeURIComponent(target.id)}/credits`, {
        method: 'POST', headers, body: JSON.stringify({ amount: correction, note: '自动化测试异常恢复' }),
      })
      restored = Number(recovery.body.data.creditBalance) === before
    }
  }
}

const finalPage = await listUsers()
const finalUser = (finalPage.items || finalPage).find((item) => item.id === target.id)
if (Number(finalUser?.creditBalance) !== before) throw new Error('测试结束后积分未恢复原值')
const ledger = (await request(`/api/credits/ledger?userId=${encodeURIComponent(target.id)}&page=1&pageSize=20`, { headers })).body.data
const testEntries = (ledger.items || []).filter((item) => String(item.note || '').startsWith('自动化测试：')).slice(0, 2)
if (testEntries.length !== 2 || testEntries.some((item) => item.changeType !== 'admin_adjust')) {
  throw new Error(`人工调整流水类型异常：${testEntries.map((item) => item.changeType).join(',')}`)
}

console.log(JSON.stringify({
  success: true,
  userId: target.id,
  positiveAdjustment: 'passed',
  negativeAdjustment: 'passed',
  listRefreshField: 'creditBalance',
  ledgerChangeType: 'admin_adjust',
  balanceRestored: true,
}, null, 2))
