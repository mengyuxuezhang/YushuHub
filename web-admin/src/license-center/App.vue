<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import PackageEditor from './PackageEditor.vue'
import GrantChangePreview from './GrantChangePreview.vue'
import { modeLabel, packageLabel, statusLabel, type CapabilityGroup, type ChangePreview, type Grant, type LicensePackage } from './types'
type State = { grants: Grant[]; packages: LicensePackage[]; capabilityGroups: CapabilityGroup[]; notices: { id: string; grantId: string; days: number; expiresAt: string; deliveredAt?: number; lastError?: string }[]; audit: { id: string; event: string; actor: string; target: string; at: number }[] }
const token = ref(''), busy = ref(false), error = ref(''), success = ref(''), secretResult = ref(''), page = ref('grants')
const state = ref<State>({ grants: [], packages: [], capabilityGroups: [], audit: [], notices: [] }), login = reactive({ username: '', password: '', code: '', challengeId: '', captchaAnswer: '' })
const loginMode = ref<'' | 'totp' | 'captcha'>(''), captchaImage = ref('')
const issue = reactive({ name: '', domain: '', modelMode: 'fixed', packageKey: 'standard:1', expiresAt: '' })
const selected = ref<Grant | null>(null), change = reactive({ status: 'enabled', expiresAt: '', modelMode: 'fixed', packageKey: '', neverExpires: false }), managementDialog = ref<HTMLDialogElement | null>(null)
const impact = ref<ChangePreview | null>(null), pendingPatch = ref<Record<string, unknown>>({})
watch(change, () => { impact.value = null; pendingPatch.value = {} }, { deep: true, flush: 'sync' })
watch(selected, async grant => { if (grant) { await nextTick(); managementDialog.value?.showModal() } })
const migration = reactive({ instanceId: '', domain: '', overlapHours: 0 })
const counts = computed(() => ({ total: state.value.grants.length, enabled: state.value.grants.filter(g => g.status === 'enabled' && (!g.expiresAt || Date.parse(g.expiresAt) > Date.now())).length, fixed: state.value.grants.filter(g => g.modelMode === 'fixed').length }))
async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch('/api/license-center/v1/operator' + path, { method, redirect: 'error', headers: { 'Content-Type': 'application/json', ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const payload = await response.json(); if (!response.ok || payload.success === false) { if (response.status === 401 && path !== '/login') token.value = ''; throw new Error(payload.error || payload.code || '请求失败') } return payload.data as T
}
async function run(work: () => Promise<void>) { busy.value = true; error.value = ''; success.value = ''; try { await work() } catch (e) { error.value = e instanceof Error ? e.message : '操作失败' } finally { busy.value = false } }
async function load() { state.value = await request<State>('/state') }
async function refreshLoginChallenge() { const challenge = await request<{ mode: 'totp' | 'captcha'; challengeId?: string; imageDataUrl?: string }>('/login-challenge'); loginMode.value = challenge.mode; login.challengeId = challenge.challengeId || ''; login.captchaAnswer = ''; captchaImage.value = challenge.imageDataUrl || '' }
async function signIn() { await run(async () => { try { const result = await request<{ token: string }>('/login', login); token.value = result.token; login.password = ''; login.code = ''; login.captchaAnswer = ''; await load() } finally { if (!token.value) await refreshLoginChallenge().catch(() => {}) } }) }
async function signOut() { await run(async () => { try { await request('/logout', {}) } finally { token.value = ''; secretResult.value = ''; selected.value = null; await refreshLoginChallenge() } }) }
onMounted(() => { void run(refreshLoginChallenge) })
function packageInput(key: string) { const at = key.lastIndexOf(':'); return { packageId: key.slice(0, at), packageVersion: Number(key.slice(at + 1)) } }
async function createGrant() { await run(async () => { const result = await request<{ code: string }>('/grants', { name: issue.name, domain: issue.domain, modelMode: issue.modelMode, ...packageInput(issue.packageKey), expiresAt: issue.expiresAt ? new Date(issue.expiresAt).toISOString() : null }); secretResult.value = result.code; await load() }) }
function edit(g: Grant) { selected.value = g; impact.value = null; change.status = g.status; change.expiresAt = ''; change.neverExpires = false; change.modelMode = g.modelMode; change.packageKey = `${g.packageId}:${g.packageVersion}`; migration.domain = g.domain; migration.instanceId = ''; migration.overlapHours = 0 }
function closeManagement() { if (!busy.value) selected.value = null }
async function previewChange() { await run(async () => { if (!selected.value) return; pendingPatch.value = { expectedVersion: selected.value.version, status: change.status, modelMode: change.modelMode, ...packageInput(change.packageKey), ...(change.neverExpires ? { expiresAt: null } : change.expiresAt ? { expiresAt: new Date(change.expiresAt).toISOString() } : {}) }; impact.value = await request(`/grants/${encodeURIComponent(selected.value.id)}/preview`, pendingPatch.value) }) }
async function applyChange() { await run(async () => { if (!selected.value || !impact.value) return; const name = selected.value.name; await request(`/grants/${encodeURIComponent(selected.value.id)}`, { ...pendingPatch.value, previewDigest: impact.value.previewDigest }, 'PATCH'); selected.value = null; impact.value = null; await load(); success.value = `${name}的授权变更已保存，在线管理后台将在下一次同步时更新（通常60秒内）。` }) }
async function reissue(g: Grant) { await run(async () => { const result = await request<{ code: string }>(`/grants/${encodeURIComponent(g.id)}/code`, {}); secretResult.value = result.code }) }
async function rotate() { await run(async () => { if (!selected.value) return; const result = await request<{ credential: string }>(`/grants/${encodeURIComponent(selected.value.id)}/rotate`, { ...migration, expectedVersion: selected.value.version }); secretResult.value = result.credential; selected.value = null; await load() }) }
async function completeMigration() { await run(async () => { if (!selected.value) return; await request(`/grants/${encodeURIComponent(selected.value.id)}/migration/complete`, { expectedVersion: selected.value.version }); selected.value = null; await load() }) }
async function publishPackage(input: LicensePackage) { await run(async () => { await request('/packages', input); await load(); success.value = `${input.name}第${input.version}版已发布。已有代理未自动修改，请到代理的“管理”中选择并保存。` }) }
</script>

<template>
  <main class="center-shell">
    <header><div><span class="eyebrow">YUSHU · LICENSE CENTER</span><h1>独立授权中心</h1><p>统一管理独立代理的资格、能力与部署。模型调用和充值由代理自己的上游账户承接。</p></div><button v-if="token" :disabled="busy" @click="signOut">退出登录</button></header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="success" class="success" role="status">{{ success }}</p>
    <form v-if="!token" class="card login" @submit.prevent="signIn"><h2>运营登录</h2><label>账号<input v-model="login.username" autocomplete="username" required /></label><label>密码<input v-model="login.password" type="password" autocomplete="current-password" required /></label><label v-if="loginMode === 'totp'">动态验证码<input v-model="login.code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required /></label><template v-else><label>图片验证码<input v-model="login.captchaAnswer" maxlength="5" autocomplete="off" required /></label><button class="captcha-refresh" type="button" :disabled="busy" aria-label="刷新验证码" @click="run(refreshLoginChallenge)"><img v-if="captchaImage" :src="captchaImage" alt="登录图片验证码" /><span v-else>加载验证码</span></button><small>看不清？点击图片刷新</small></template><button class="primary" :disabled="busy || !loginMode">登录</button><small>登录凭据只用于本次会话，不存入浏览器持久存储。</small></form>
    <template v-else>
      <div class="stats"><article class="card"><span>代理授权</span><strong>{{ counts.total }}</strong></article><article class="card"><span>正常状态</span><strong>{{ counts.enabled }}</strong></article><article class="card"><span>固定文本模式</span><strong>{{ counts.fixed }}</strong></article></div>
      <nav><button v-for="tab in [{id:'grants',name:'代理授权'},{id:'packages',name:'套餐配置'},{id:'audit',name:'操作审计'}]" :key="tab.id" :class="{active:page===tab.id}" @click="page=tab.id">{{ tab.name }}</button><button :disabled="busy" @click="run(load)">刷新</button></nav>
      <section v-if="secretResult" class="card notice"><h2>一次性资料</h2><p>请通过受控方式交付给对应代理，关闭后不再显示。</p><code>{{ secretResult }}</code><button @click="secretResult=''">已保存，隐藏</button></section>
      <section v-if="page==='grants'" class="card"><h2>签发独立代理授权</h2><form class="grid" @submit.prevent="createGrant"><label>代理名称<input v-model="issue.name" required /></label><label>部署域名<input v-model="issue.domain" type="url" placeholder="https://agent.example.com" required /></label><label>功能套餐<select v-model="issue.packageKey"><option v-for="p in state.packages" :key="p.id+':'+p.version" :value="p.id+':'+p.version">{{ p.name }} · 第{{ p.version }}版</option></select></label><label>文本供应商<select v-model="issue.modelMode"><option value="fixed">固定 OKPA API</option><option value="custom">自定义服务商</option></select></label><label>到期时间（留空不限期）<input v-model="issue.expiresAt" type="datetime-local" /></label><button class="primary" :disabled="busy">签发一次性激活码</button></form>
        <div class="table-scroll"><table><thead><tr><th>代理</th><th>模式 / 套餐</th><th>状态 / 期限</th><th>绑定</th><th>操作</th></tr></thead><tbody><tr v-for="g in state.grants" :key="g.id"><td><strong>{{ g.name }}</strong><small>{{ g.id }}</small></td><td>{{ modeLabel(g.modelMode) }}<small>{{ packageLabel(state.packages,g.packageId,g.packageVersion) }}</small></td><td>{{ statusLabel(g.status === 'enabled' && g.expiresAt && Date.parse(g.expiresAt) <= Date.now() ? 'expired' : g.status) }}<small>{{ g.expiresAt ? new Date(g.expiresAt).toLocaleString('zh-CN') : '不限期' }}</small></td><td>{{ g.domain }}<small>{{ g.instanceId || '未激活' }}</small></td><td><button :disabled="busy || g.status==='revoked'" @click="edit(g)">管理</button><button v-if="!g.instanceId" :disabled="busy" @click="reissue(g)">作废重发激活码</button></td></tr></tbody></table></div>
      </section>
      <PackageEditor v-if="page==='packages'" :packages="state.packages" :groups="state.capabilityGroups" :busy="busy" :message="success" :error-message="error" @publish="publishPackage" />
      <section v-if="page==='audit'" class="card"><h2>到期通知</h2><p v-if="!state.notices.length">尚无到期提醒</p><p v-for="n in state.notices" :key="n.id">{{ n.grantId }} · {{ n.days }}天 · {{ n.deliveredAt ? '已发送' : n.lastError ? '发送失败，等待重试' : '等待Webhook发送' }}</p><h2>最近操作</h2><table><thead><tr><th>时间</th><th>操作者</th><th>事件</th><th>对象</th></tr></thead><tbody><tr v-for="a in state.audit" :key="a.id"><td>{{ new Date(a.at).toLocaleString('zh-CN') }}</td><td>{{ a.actor }}</td><td>{{ a.event }}</td><td>{{ a.target }}</td></tr></tbody></table></section>
      <dialog v-if="selected" ref="managementDialog" class="grant-dialog" aria-labelledby="grant-dialog-title" @cancel.prevent="closeManagement">
        <div class="section-heading"><h2 id="grant-dialog-title">管理授权：{{ selected.name }}</h2><button :disabled="busy" @click="closeManagement">关闭</button></div>
        <p>修改只影响当前代理。固定／自定义服务商与功能套餐分别设置；已有用户权益和累计用量保持。</p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <form @submit.prevent="previewChange"><fieldset class="grid package-controls" :disabled="busy">
          <label>授权状态<select v-model="change.status"><option value="enabled">正常</option><option value="suspended">暂停</option><option value="revoked">撤销（不可恢复）</option></select></label>
          <label>文本服务商模式<select v-model="change.modelMode"><option value="fixed">固定 OKPA API</option><option value="custom">允许自定义服务商</option></select></label>
          <label>功能套餐<select v-model="change.packageKey"><option v-for="p in state.packages" :key="p.id+':'+p.version" :value="p.id+':'+p.version">{{ packageLabel(state.packages,p.id,p.version) }}</option></select></label>
          <label class="checkbox-line"><input v-model="change.neverExpires" type="checkbox" />改为不限期</label>
          <label>新到期时间（留空保持）<input v-model="change.expiresAt" type="datetime-local" :disabled="change.neverExpires" /></label>
          <button :disabled="busy">预览变更</button>
        </fieldset></form>
        <GrantChangePreview v-if="impact" :preview="impact" :packages="state.packages" :groups="state.capabilityGroups" />
        <p v-else class="muted">修改配置后，先点击“预览变更”核对，再确认保存。</p>
        <div class="grant-save"><p>确认保存后，在线代理后台通常在60秒内同步新授权。</p><button class="primary" :disabled="busy || !impact" @click="applyChange">确认保存授权变更</button></div>
        <details class="migration-settings"><summary>部署迁移（高级操作）</summary><form class="grid" @submit.prevent="rotate"><label>新实例ID<input v-model="migration.instanceId" required /></label><label>新域名<input v-model="migration.domain" type="url" required /></label><label>双实例小时（0–24）<input v-model.number="migration.overlapHours" type="number" min="0" max="24" /></label><button :disabled="busy">轮换实例凭据</button></form><button :disabled="busy" @click="completeMigration">提前撤销旧实例访问</button></details>
      </dialog>
    </template>
  </main>
</template>
