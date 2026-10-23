import express from 'express'
import fs from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { repoRoot, WEB_INDEX_PATH, ADMIN_V2_INDEX_PATH, SITE_INDEX_PATH } from '../src/config/paths.mjs'
import { CENTER_SUPPLIER_MANAGEMENT_ENABLED } from '../src/config/env.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use('/admin/static', express.static(path.dirname(WEB_INDEX_PATH), { maxAge: '5m' }))
app.use('/admin/v2/assets', express.static(path.join(path.dirname(ADMIN_V2_INDEX_PATH), 'assets'), { maxAge: '5m' }))
app.use('/site', express.static(path.dirname(SITE_INDEX_PATH), { maxAge: '5m' }))

const ADMIN_HTML = fs.readFileSync(WEB_INDEX_PATH, 'utf8')
  .replace(
    "${CENTER_SUPPLIER_MANAGEMENT_ENABLED ? 'true' : 'false'}",
    CENTER_SUPPLIER_MANAGEMENT_ENABLED ? 'true' : 'false',
  )
  .replaceAll('__ADMIN_ASSET_VERSION__', 'smoke-test-version-testhash')
const SITE_HTML = fs.readFileSync(SITE_INDEX_PATH, 'utf8')
const ADMIN_V2_HTML = fs.readFileSync(ADMIN_V2_INDEX_PATH, 'utf8')

app.get('/', (_req, res) => {
  res.type('html').send(SITE_HTML)
})

app.get(['/admin', '/admin/'], (_req, res) => {
  res.redirect(302, '/admin/v2/')
})

app.get(['/admin/legacy', '/admin/legacy/'], (_req, res) => {
  res.type('html').send(ADMIN_HTML)
})

app.get(['/admin/v2', '/admin/v2/', '/admin/v2/*'], (_req, res) => {
  res.type('html').send(ADMIN_V2_HTML)
})

const server = http.createServer(app)
const PORT = 17999

async function fetchText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    }).on('error', reject)
  })
}

async function run() {
  await new Promise((resolve) => server.listen(PORT, resolve))
  console.log(`Smoke test server on http://127.0.0.1:${PORT}`)

  let passed = 0
  let failed = 0

  // Test 1: GET / returns landing HTML
  const home = await fetchText(`http://127.0.0.1:${PORT}/`)
  if (home.status === 200 && home.body.includes('Agent AI Admin') && home.body.includes('href="/admin"')) {
    console.log('PASS: GET / returns site landing page with admin link')
    passed++
  } else {
    console.log(`FAIL: GET / status=${home.status}, has landing marker=${home.body.includes('Agent AI Admin')}`)
    failed++
  }

  // Test 2: the canonical admin entry points at the completed Vue admin.
  const adminEntry = await fetchText(`http://127.0.0.1:${PORT}/admin`)
  if (adminEntry.status === 302 && adminEntry.headers.location === '/admin/v2/') {
    console.log('PASS: GET /admin redirects to the completed Vue admin')
    passed++
  } else {
    console.log(`FAIL: GET /admin status=${adminEntry.status}, location=${adminEntry.headers.location || '-'}`)
    failed++
  }

  const admin = await fetchText(`http://127.0.0.1:${PORT}/admin/legacy`)
  if (admin.status === 200 && admin.body.includes('<script src="/admin/static/js/admin.js?v=smoke-test-version-testhash"></script>')) {
    console.log('PASS: GET /admin/legacy keeps the rollback UI available')
    passed++
  } else {
    console.log(`FAIL: GET /admin/legacy status=${admin.status}, missing legacy JS script tag`)
    failed++
  }

  // Test 3: Template interpolation replaced
  if (admin.body.includes('window.CENTER_SUPPLIER_MANAGEMENT_ENABLED = false;')) {
    console.log('PASS: Template interpolation replaced correctly')
    passed++
  } else if (admin.body.includes('${CENTER_SUPPLIER_MANAGEMENT_ENABLED')) {
    console.log('FAIL: Template interpolation NOT replaced')
    failed++
  } else {
    console.log('PASS: Template interpolation replaced (value may differ)')
    passed++
  }

  // The completed admin remains directly addressable for history fallback.
  const adminV2 = await fetchText(`http://127.0.0.1:${PORT}/admin/v2`)
  const adminV2AssetMatch = adminV2.body.match(/src="(\/admin\/v2\/assets\/[^"]+\.js)"/)
  if (adminV2.status === 200 && adminV2.body.includes('id="app"') && adminV2AssetMatch) {
    const adminV2Asset = await fetchText(`http://127.0.0.1:${PORT}${adminV2AssetMatch[1]}`)
    if (adminV2Asset.status === 200 && adminV2Asset.body.length > 1000) {
      console.log('PASS: GET /admin/v2 returns the isolated Vue admin with versioned assets')
      passed++
      if (adminV2Asset.body.includes('首页装修') && adminV2Asset.body.includes('/api/custom-homepage')) {
        console.log('PASS: Vue admin includes custom homepage publishing UI and API wiring')
        passed++
      } else {
        console.log('FAIL: Vue admin is missing custom homepage publishing UI or API wiring')
        failed++
      }
    } else {
      console.log(`FAIL: admin v2 asset status=${adminV2Asset.status}`)
      failed++
    }
  } else {
    console.log(`FAIL: GET /admin/v2 status=${adminV2.status}, missing Vue app or asset`)
    failed++
  }

  // Test 4: GET /admin/static/styles/admin.css returns CSS
  const css = await fetchText(`http://127.0.0.1:${PORT}/admin/static/styles/admin.css`)
  if (css.status === 200 && css.body.includes('--primary-color') && css.body.includes('@media')) {
    console.log(`PASS: GET /admin/static/styles/admin.css returns CSS (${css.body.length} chars)`)
    passed++
  } else {
    console.log(`FAIL: GET /admin/static/styles/admin.css status=${css.status}, len=${css.body.length}`)
    failed++
  }

  if (css.body.includes('.login-cube-face') && css.body.includes('@keyframes loginCubeRotate') && css.body.includes('--login-background-image: none')) {
    console.log('PASS: default login hero uses a self-contained CSS 3D scene without a bundled background image')
    passed++
  } else {
    console.log('FAIL: pure CSS login hero scene is incomplete')
    failed++
  }

  // Test 5: GET /admin/static/js/admin.js returns JS
  const js = await fetchText(`http://127.0.0.1:${PORT}/admin/static/js/admin.js`)
  if (js.status === 200 && js.body.includes('window.CENTER_SUPPLIER_MANAGEMENT_ENABLED') && js.body.includes('boot()')) {
    console.log(`PASS: GET /admin/static/js/admin.js returns JS (${js.body.length} chars)`)
    passed++
  } else {
    console.log(`FAIL: GET /admin/static/js/admin.js status=${js.status}, len=${js.body.length}`)
    failed++
  }

  // Test 6: GET /site/styles.css returns landing CSS
  const siteCss = await fetchText(`http://127.0.0.1:${PORT}/site/styles.css`)
  if (siteCss.status === 200 && siteCss.body.includes('.site-header') && siteCss.body.includes('.hero')) {
    console.log(`PASS: GET /site/styles.css returns landing CSS (${siteCss.body.length} chars)`)
    passed++
  } else {
    console.log(`FAIL: GET /site/styles.css status=${siteCss.status}, len=${siteCss.body.length}`)
    failed++
  }

  // Test 7: JS does NOT contain unreplaced template
  if (!js.body.includes('${CENTER_SUPPLIER_MANAGEMENT_ENABLED')) {
    console.log('PASS: admin.js has no unreplaced template interpolation')
    passed++
  } else {
    console.log('FAIL: admin.js contains unreplaced template interpolation')
    failed++
  }

  // Test 8: forced update dialog is present
  if (admin.body.includes('id="updateReminderBackdrop"') && admin.body.includes('id="updateReminderNotes"') && admin.body.includes('id="applyForcedUpdateBtn"') && admin.body.includes('系统必须更新')) {
    console.log('PASS: admin HTML contains forced update dialog')
    passed++
  } else {
    console.log('FAIL: admin HTML is missing update reminder dialog markers')
    failed++
  }

  // Test 9: forced update is permission-gated and cannot be dismissed
  if (js.body.includes("can('self_update.manage')") && js.body.includes("applySelfUpdate({ forced: true })") && js.body.includes('forcedUpdateInProgress') && !js.body.includes('closeUpdateReminder')) {
    console.log('PASS: forced update is permission-gated and non-dismissible')
    passed++
  } else {
    console.log('FAIL: update reminder permission/dismiss behavior is missing')
    failed++
  }

  // Test 10: update reminder has responsive styling
  if (css.body.includes('.update-reminder-dialog') && css.body.includes('.update-reminder-notes')) {
    console.log('PASS: update reminder CSS is present')
    passed++
  } else {
    console.log('FAIL: update reminder CSS is missing')
    failed++
  }

  // Test 11: redeem code form supports both points and membership rewards
  if (admin.body.includes('id="redeemRewardType"') && admin.body.includes('id="redeemMembershipCardId"') && admin.body.includes('id="redeemMembershipPackageInfo"')) {
    console.log('PASS: redeem code form contains points and membership reward controls')
    passed++
  } else {
    console.log('FAIL: redeem code membership reward controls are missing')
    failed++
  }

  // Test 12: redeem code JS loads membership options and submits reward type
  if (js.body.includes('/api/redeem-codes/membership-options') && js.body.includes('updateRedeemRewardTypeFields') && js.body.includes('payload.membershipCardId')) {
    console.log('PASS: redeem code JS supports membership option loading and payloads')
    passed++
  } else {
    console.log('FAIL: redeem code membership behavior is missing from admin JS')
    failed++
  }

  // Test 13: payment center contains isolated WeChat and Alipay configuration forms
  if (admin.body.includes('id="paymentsView"') && admin.body.includes('id="wechatPaymentApiV3Key"') && admin.body.includes('id="alipayPaymentFaceToFaceEnabled"') && admin.body.includes('id="alipayPaymentPagePayEnabled"')) {
    console.log('PASS: payment center contains WeChat Native and Alipay product configuration')
    passed++
  } else {
    console.log('FAIL: payment center configuration controls are missing')
    failed++
  }

  // Test 14: payment center loads tenant-scoped configs/orders and exposes safe actions
  if (js.body.includes("api('/api/payment-configs')") && js.body.includes("api('/api/payment-orders')") && js.body.includes("can('payments.manage')") && js.body.includes('query-payment-order-btn') && js.body.includes('paymentSettingsDirty[provider]')) {
    console.log('PASS: payment center JS loads permission-gated configs and orders')
    passed++
  } else {
    console.log('FAIL: payment center JS behavior is incomplete')
    failed++
  }

  // Test 15: membership cards expose one entitlement and lock the built-in free duration
  if (admin.body.includes('每张会员卡只有一组权益') && !admin.body.includes('id="addMembershipPackageBtn"') && js.body.includes('data-system-builtin') && !js.body.includes('payload.membershipPackageName')) {
    console.log('PASS: membership editor and redeem flow use one entitlement, with permanent free membership enforced in the UI')
    passed++
  } else {
    console.log('FAIL: single-entitlement membership UI rules are incomplete')
    failed++
  }

  // Test 16: credit ledger supports tenant-safe server pagination and admin owner filtering
  if (admin.body.includes('id="ledgerOwnerFilter"') && admin.body.includes('id="creditLedgerPrevBtn"') && admin.body.includes('id="creditLedgerNextBtn"')
    && js.body.includes("params.set('ownerUserId', ownerUserId)") && js.body.includes("params.set('changeType', changeType)")
    && !/function renderKeys\(\)\s*\{\s*if \(me\.role !== 'admin'\)/.test(js.body)) {
    console.log('PASS: credit ledger exposes owner filters and server-backed pagination for admins and agents')
    passed++
  } else {
    console.log('FAIL: credit ledger owner filtering or pagination behavior is incomplete')
    failed++
  }

  // Test 17: model service additions are checked on login and synced by affected scope
  if (admin.body.includes('id="modelUpdateReminderBackdrop"') && admin.body.includes('id="applyModelUpdateReminderBtn"')
    && js.body.includes("api('/api/model-service/update-status')") && js.body.includes('availableModelUpdateScopes()')
    && js.body.includes("{ key: 'providers', label: '服务商'") && js.body.includes("{ key: 'models', label: '模型管理'")
    && js.body.includes("{ key: 'pricingRules', label: '计费规则'") && js.body.includes('for (const definition of available)')) {
    console.log('PASS: model service update reminder checks and syncs only affected permitted scopes')
    passed++
  } else {
    console.log('FAIL: model service update reminder behavior is incomplete')
    failed++
  }

  // Test 18: curated skill publishing and tenant distribution controls are present
  if (admin.body.includes('id="skillsView"') && admin.body.includes('id="curatedPackageFile"') && admin.body.includes('id="curatedDistributionEnabled"')
    && js.body.includes("api('/api/curated-skills')") && js.body.includes("'/api/curated-skill-distributions/'") && js.body.includes('new FormData()')) {
    console.log('PASS: curated skill publishing and tenant distribution UI is wired')
    passed++
  } else {
    console.log('FAIL: curated skill admin UI is incomplete')
    failed++
  }

  // Test 19: downstream curated skill updates are visible, syncable, and creator deletion is exposed
  if (admin.body.includes('id="curatedUpdateReminderBackdrop"') && admin.body.includes('id="applyCuratedUpdateReminderBtn"')
    && admin.body.includes('上传为草稿') && admin.body.includes('总后台发布会通知下游')
    && js.body.includes("api('/api/curated-skill-sync/update-status')") && js.body.includes("api('/api/curated-skill-sync'")
    && js.body.includes("api('/api/curated-skill-sync/jobs/'") && js.body.includes('renderCuratedSyncProgress')
    && admin.body.includes('id="curatedSyncProgress"') && js.body.includes('delete-curated-skill') && js.body.includes("method: 'DELETE'")) {
    console.log('PASS: curated skill downstream reminder, real sync progress, publishing, and creator deletion are wired')
    passed++
  } else {
    console.log('FAIL: curated skill downstream update or creator deletion behavior is incomplete')
    failed++
  }

  // Test 20: curated MCP uses a persistent editor with safe deletion and center synchronization
  const curatedMcpUiStart = js.body.indexOf('function renderCuratedMcps()')
  const curatedMcpUiEnd = js.body.indexOf('async function openCuratedSkill', curatedMcpUiStart)
  const curatedMcpUi = curatedMcpUiStart >= 0 && curatedMcpUiEnd > curatedMcpUiStart ? js.body.slice(curatedMcpUiStart, curatedMcpUiEnd) : ''
  if (admin.body.includes('id="mcpView"') && admin.body.includes('id="curatedMcpRows"')
    && admin.body.includes('id="createCuratedMcpBtn"') && admin.body.includes('id="curatedMcpDrawer"')
    && admin.body.includes('id="saveCuratedMcpBtn"') && admin.body.includes('id="createCuratedMcpVersionBtn"')
    && admin.body.includes('id="saveCuratedMcpDistributionBtn"') && admin.body.includes('id="syncCuratedMcpsBtn"')
    && admin.body.includes('<option value="json">JSON 配置</option>') && admin.body.includes('id="curatedMcpJson"')
    && js.body.includes("api('/api/curated-mcps')") && js.body.includes("'/api/curated-mcp-distributions/'")
    && js.body.includes("'/api/curated-mcp-sync'") && js.body.includes("method: 'DELETE'")
    && curatedMcpUi.includes('sourceType') && curatedMcpUi.includes('function curatedMcpConfigFromJson()')
    && curatedMcpUi.includes("normalizedValue || '${' + normalizedName + '}'") && !curatedMcpUi.includes('prompt(')) {
    console.log('PASS: curated MCP persistent editing, creator deletion, publishing, distribution, and center sync UI are wired')
    passed++
  } else {
    console.log('FAIL: curated MCP admin UI is incomplete')
    failed++
  }

  // Test 21: delegated build-center tasks are clearly read-only in the platform admin
  if (js.body.includes('function isCenterDelegatedBuild') && js.body.includes('供应商代构建')
    && js.body.includes('测试：已同步至供应商并清理') && js.body.includes('正式：由供应商后台发布')
    && js.body.includes('b.canOperate !== false && !centerDelegated')) {
    console.log('PASS: delegated build-center tasks are labeled and read-only')
    passed++
  } else {
    console.log('FAIL: delegated build-center task labeling or action guards are incomplete')
    failed++
  }

  // Test 21: build columns stay balanced and supplier quotas use center-wide usage
  if (admin.body.includes('class="builds-table"') && admin.body.includes('class="build-col-status"')
    && css.body.includes('.builds-table .build-col-status') && css.body.includes('.transfer-progress { width: 100%; min-width: 0;')
    && js.body.includes("s.projectUsageSynced === false ? '待下游同步'") && js.body.includes('s.usedBuilds ?? s.buildCount')) {
    console.log('PASS: build table widths and supplier-wide quota usage are rendered')
    passed++
  } else {
    console.log('FAIL: build table width or supplier-wide quota rendering is incomplete')
    failed++
  }

  // Test 22: public branding is applied before either login or admin UI becomes visible
  if (admin.body.includes('id="loginView" class="login-wrap hidden"')
    && js.body.includes("api('/api/public-settings')") && js.body.includes('await loadPublicPlatformSettings();')
    && admin.body.includes('id="loginBrandName"') && admin.body.includes('id="loginHeroTitle"')
    && admin.body.includes('id="loginCrystalFaceFront"></span>') && admin.body.includes('id="loginCrystalFaceBack"></span>')
    && admin.body.includes('id="loginCrystalFaceRight"></span>') && admin.body.includes('id="loginCrystalFaceLeft"></span>')
    && admin.body.includes('id="loginCrystalFaceTop"></span>') && admin.body.includes('id="loginCrystalFaceBottom"></span>')
    && admin.body.includes('id="settingLoginBackgroundUrl"') && admin.body.includes('id="settingLoginPanelColor"')
    && admin.body.includes('id="settingCrystalFaceFront"') && admin.body.includes('id="settingCrystalFaceBottom"')
    && admin.body.includes('id="settingLoginSignalTitle0"') && admin.body.includes('id="settingLoginCapabilitySubtitle3"')
    && js.body.includes("$('loginBrandName').textContent = systemName")
    && js.body.includes("$('loginHeroTitle').textContent = loginTitle")
    && js.body.includes("platformSettings.loginBackgroundUrl || ''")
    && js.body.includes('loginContent: collectLoginContent()')
    && js.body.includes("$('loginSignalTitle' + index).textContent = item.title")
    && js.body.includes("$('loginCapabilitySubtitle' + index).textContent = item.subtitle")
    && js.body.includes("if ($(id)) $(id).textContent = crystalFaceTexts[key]")
    && js.body.includes('crystalFaceTexts, buildCenterUrl:')
    && js.body.includes("successMessage: '平台设置保存成功，登录页品牌与晶体配置已生效'")
    && js.body.includes("Object.prototype.hasOwnProperty.call(platformSettings, 'logoText')")
    && js.body.indexOf('await loadPublicPlatformSettings();') < js.body.indexOf("const session = await api('/api/me');")) {
    console.log('PASS: public white-label branding is applied to the redesigned login before it is shown')
    passed++
  } else {
    console.log('FAIL: platform branding can still flash default content during startup')
    failed++
  }

  // Test 23: worker status exposes the checked-out Desktop source version and match state
  if (admin.body.includes('Worker / Desktop 源码') && js.body.includes('w.expectedPackageVersion')
    && js.body.includes('在线 · 版本匹配') && js.body.includes('在线 · 待同步到 v')) {
    console.log('PASS: worker rows expose Desktop source version matching')
    passed++
  } else {
    console.log('FAIL: worker Desktop source version matching is not visible')
    failed++
  }

  // Test 24: one canonical release feed exposes bounded recent history from the build page
  if (js.body.includes('当前 Agent 最新版 v')
    && admin.body.includes('id="sourceHistoryDrawer"')
    && js.body.includes("$('sourceHistoryBtn').onclick = openSourceHistoryDrawer")
    && admin.body.includes('id="selfUpdateHistory"')
    && js.body.includes('sourceInfo.history')
    && js.body.includes('status.history.slice(0, 20)')) {
    console.log('PASS: release pages expose bounded current-generation history')
    passed++
  } else {
    console.log('FAIL: bounded release history is not exposed correctly')
    failed++
  }

  // Test 25: curated markets auto-detect upstream updates and show explicit action feedback
  if (admin.body.includes('id="syncCuratedSkillsBtn"') && admin.body.includes('id="syncCuratedMcpsBtn"')
    && admin.body.includes('id="curatedMcpUpdateReminderBackdrop"') && admin.body.includes('id="applyCuratedMcpUpdateReminderBtn"')
    && admin.body.includes('id="operationToastRegion"') && admin.body.includes('id="curatedSkillMsg" class="action-feedback hidden" aria-live="polite"')
    && admin.body.includes('id="curatedMcpMsg" class="action-feedback hidden" aria-live="polite"')
    && admin.body.includes('id="curatedAgentSaveMsg" class="action-feedback hidden" aria-live="polite"')
    && js.body.includes('function maybeShowCuratedMcpUpdateReminder()') && js.body.includes("if (tab === 'skills') loadCuratedSkillUpdateStatus()")
    && js.body.includes("if (tab === 'mcp') loadCuratedMcpUpdateStatus()") && js.body.includes('setInterval(async () => {')
    && js.body.includes('runActionWithFeedback({ button: $(\'saveCuratedMcpBtn\')')
    && js.body.includes('runActionWithFeedback({ button: $(\'saveCuratedSkillBtn\')')
    && js.body.includes('runActionWithFeedback({ button: $(\'createCuratedMcpVersionBtn\')')
    && js.body.includes('runActionWithFeedback({ button: $(\'uploadCuratedVersionBtn\')')
    && js.body.includes('runActionWithFeedback({ button: $(\'saveCuratedMcpDistributionBtn\')')
    && js.body.includes('runActionWithFeedback({ button: $(\'saveCuratedDistributionBtn\')')
    && css.body.includes('.operation-toast-region') && css.body.includes('.action-feedback.succeeded') && css.body.includes('.action-feedback.failed')) {
    console.log('PASS: curated MCP and skill markets auto-detect updates and expose visible staged action feedback')
    passed++
  } else {
    console.log('FAIL: curated market update detection or staged action feedback is incomplete')
    failed++
  }

  // Test 26: curated agents synchronize from the center and keep choices aligned
  if (admin.body.includes('id="syncCuratedAgentsBtn"')
    && admin.body.includes('id="curatedAgentUpdateReminderBackdrop"')
    && admin.body.includes('id="applyCuratedAgentUpdateReminderBtn"')
    && js.body.includes("api('/api/curated-agent-sync/update-status')")
    && js.body.includes("api('/api/curated-agent-sync'")
    && js.body.includes("api('/api/curated-agent-sync/jobs/'")
    && js.body.includes('保存成功：专家')
    && js.body.includes('curatedAgents = [saved, ...curatedAgents.filter')
    && js.body.includes('function maybeShowCuratedAgentUpdateReminder()')
    && js.body.includes("if (tab === 'curatedAgents') loadCuratedAgentUpdateStatus()")
    && css.body.includes('.model-access-list > label')
    && css.body.includes('.form-drawer-body .checkbox-line input[type="checkbox"]')
    && admin.body.includes('class="checkbox-line"')) {
    console.log('PASS: curated agents support center update sync and aligned dependency/distribution choices')
    passed++
  } else {
    console.log('FAIL: curated agent center sync or checkbox alignment is incomplete')
    failed++
  }

  // Test 27: retired Desktop capabilities have no Admin authorization surface
  if (!admin.body.includes('<code>video-creation</code>')
    && !admin.body.includes('data-tab="capabilities"') && !admin.body.includes('id="capabilitiesView"')) {
    console.log('PASS: retired Desktop capabilities have no Admin authorization surface')
    passed++
  } else {
    console.log('FAIL: duplicate built-in capability management surface still exists')
    failed++
  }

  // Test 28: ordinary curated skill distribution remains without capability-specific gates
  if (!js.body.includes("skill.id === 'video-creation'") && !js.body.includes('视频创作开关')
    && !js.body.includes("skill.id === 'computer-control'") && !js.body.includes('电脑操作开关')
    && js.body.includes("'/api/curated-skill-distributions/'") && !js.body.includes("'/api/builtin-capabilities/video-creation/policy'")) {
    console.log('PASS: curated skill distribution has no capability-specific gates')
    passed++
  } else {
    console.log('FAIL: video creation is not wired to ordinary skill distribution')
    failed++
  }

  // Test 28: operators can manually create end-user client accounts
  if (admin.body.includes('id="openEndUserDrawerBtn"')
    && admin.body.includes('id="endUserCreateUsername"')
    && admin.body.includes('id="endUserCreateEmail"')
    && admin.body.includes('id="endUserCreatePassword"')
    && admin.body.includes('创建后可直接使用该账号登录客户端')
    && js.body.includes("action: () => api('/api/end-users', { method: 'POST'")
    && js.body.includes("$('saveEndUserBtn').onclick = createEndUserAccount")) {
    console.log('PASS: end-user management exposes secure manual account creation')
    passed++
  } else {
    console.log('FAIL: manual end-user account creation is incomplete')
    failed++
  }

  // Test 29: versioned static assets cannot mix a new HTML shell with stale JavaScript
  if (admin.body.includes('/admin/static/js/admin.js?v=smoke-test-version-testhash')
    && admin.body.includes('/admin/static/styles/admin.css?v=smoke-test-version-testhash')
    && !admin.body.includes('__ADMIN_ASSET_VERSION__')) {
    console.log('PASS: admin static assets are versioned to prevent stale click handlers after releases')
    passed++
  } else {
    console.log('FAIL: admin static assets are not release-versioned')
    failed++
  }
  const organizationJs = await fetchText(`http://127.0.0.1:${PORT}/admin/static/js/views/organizations.js`)

  // Organization capabilities and permission constraints use product-facing Chinese labels.
  if (!admin.body.includes('<label>岗位类型</label>')
    && admin.body.includes('所有模板都可以自由选择权限')
    && js.body.includes('岗位与主体限制')
    && js.body.includes("return '全部模板可选'")
    && js.body.includes('需具备成员与下级管理授权')
    && !js.body.includes("return '平台管理员 / 代理商'")) {
    console.log('PASS: role templates expose all permissions without a position-type gate')
    passed++
  } else {
    console.log('FAIL: permission constraints still expose legacy platform-admin or agent terminology')
    failed++
  }

  if (organizationJs.status === 200
    && organizationJs.body.includes("escapeHtml(item.name || '未命名能力')")
    && organizationJs.body.includes('capability-picker-search')
    && organizationJs.body.includes("escapeHtml(item.description)")
    && !organizationJs.body.includes('请输入要授予的能力序号')) {
    console.log('PASS: transferable capabilities use a searchable grouped multi-select')
    passed++
  } else {
    console.log('FAIL: transferable capabilities still expose raw permission keys')
    failed++
  }

  const organizationViewSource = await fsPromises.readFile(path.join(repoRoot, 'web/js/views/organizations.js'), 'utf8')
  if (admin.body.includes('<th>登录账号</th>')
    && organizationViewSource.includes('organization-password-btn')
    && organizationViewSource.includes('organization-delete-btn')) {
    console.log('PASS: child organizations expose login maintenance')
    passed++
  } else {
    console.log('FAIL: child organization account maintenance is missing')
    failed++
  }

  if (!admin.body.includes('企业工作台')
    && !admin.body.includes('企业员工')
    && !admin.body.includes('企业额度')
    && !admin.body.includes('企业用量')
    && !admin.body.includes('id="projectClientMode"')
    && !organizationViewSource.includes('businessMode')
    && !organizationViewSource.includes('/enterprise-quota')) {
    console.log('PASS: enterprise business controls are retired from the legacy admin')
    passed++
  } else {
    console.log('FAIL: enterprise business controls remain in the legacy admin')
    failed++
  }

  if (admin.body.includes('id="agentRole" type="hidden"')
    && admin.body.includes('数据范围：当前组织')
    && js.body.includes("if (!template) throw new Error('请选择角色模板')")
    && js.body.includes("dataScope: 'self'")) {
    console.log('PASS: backend accounts derive position and current-organization scope from role templates')
    passed++
  } else {
    console.log('FAIL: backend account creation still exposes redundant position or data-scope choices')
    failed++
  }

  if (admin.body.includes('id="roleTemplatePermissionMsg" class="action-feedback hidden"')
    && js.body.includes("setActionFeedback('roleTemplatePermissionMsg', '正在保存模板权限...', 'running')")
    && js.body.includes("setActionFeedback('roleTemplatePermissionMsg', message, 'succeeded')")
    && js.body.includes("setActionFeedback('roleTemplatePermissionMsg', message, 'failed')")) {
    console.log('PASS: role-template permission saves expose running, success, and failure feedback')
    passed++
  } else {
    console.log('FAIL: role-template permission saves do not provide complete feedback')
    failed++
  }

  if (admin.body.includes('分组权限覆盖角色模板')
    && admin.body.includes('多个启用分组时，各分组权限取并集')
    && admin.body.includes('明确撤权，不会回退角色模板')) {
    console.log('PASS: account group override and union rules are explained in the UI')
    passed++
  } else {
    console.log('FAIL: account group precedence remains ambiguous in the UI')
    failed++
  }

  const organizationRouteSource = await fsPromises.readFile(path.join(repoRoot, 'src/routes/organizations.mjs'), 'utf8')
  if (organizationRouteSource.includes("capability.key === '*'") && organizationRouteSource.includes("name: '全部权限'")) {
    console.log('PASS: organization capability API localizes the all-permissions wildcard')
    passed++
  } else {
    console.log('FAIL: all-permissions wildcard is missing Chinese metadata')
    failed++
  }

  const serverSource = await fsPromises.readFile(path.join(repoRoot, 'cloud/ai-admin/server.mjs'), 'utf8')
  if (/function normalizeRoleTemplate[\s\S]*?id: row\.id,\s*organizationId: row\.organization_id \|\| ''/.test(serverSource)
    && serverSource.includes("template.organizationId !== (context?.organizationId || '')")) {
    console.log('PASS: custom role templates retain organization ownership for permission saves')
    passed++
  } else {
    console.log('FAIL: custom role template ownership is lost before permission saves')
    failed++
  }

  if (/function normalizeUserGroup[\s\S]*?id: row\.id,\s*organizationId: row\.organization_id \|\| ''/.test(serverSource)) {
    console.log('PASS: account groups retain organization ownership for member validation')
    passed++
  } else {
    console.log('FAIL: account group organization ownership is lost before member validation')
    failed++
  }

  const listUserGroupMembersSource = serverSource.match(/async function listUserGroupMembers[\s\S]*?\r?\n}\r?\n\r?\nasync function saveUserGroupMembers/)?.[0] || ''
  if (/SELECT u\.\*[\s\S]*?FROM ai_user_group_members/.test(listUserGroupMembersSource)
    && !/s\.device_id/.test(listUserGroupMembersSource)) {
    console.log('PASS: account group member reads do not reference an unjoined session table')
    passed++
  } else {
    console.log('FAIL: account group member reads still reference an unjoined session table')
    failed++
  }

  server.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error('Smoke test error:', err)
  server.close()
  process.exit(1)
})
