<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { centerLogin, centerLogout, centerRequest, centerState, issueLicense } from '@/api/license-center'
import type { LicenseCenterState, LicenseGrant } from '@/types/licensing'
const state = ref<LicenseCenterState | null>(null), busy = ref(false), error = ref(''), secret = ref(''), packageJson = ref(''), renewal = ref('')
const login = reactive({ username: '', password: '', code: '' })
const form = reactive({ name: '', package: 'first-custom:1', parentId: '', domain: '', modelIds: '', expiresAt: '' })
const selectedPackage = computed(() => state.value?.packages.find(p => `${p.id}:${p.version}` === form.package))
const parents = computed(() => state.value?.grants.filter(g => g.level === 1 && g.instanceId && g.status === 'enabled') || [])
async function perform(operation: () => Promise<unknown>) {
  busy.value = true; error.value = ''; secret.value = ''
  try { await operation() } catch (e) { error.value = e instanceof Error ? e.message : '操作失败' } finally { busy.value = false }
}
async function refresh() { state.value = await centerState() }
async function signIn() { await perform(async () => { await centerLogin(login); login.password = ''; login.code = ''; await refresh() }) }
async function issue() {
  await perform(async () => {
    const [packageId, version] = form.package.split(':')
    const result = await issueLicense({ name: form.name, packageId, packageVersion: Number(version), parentId: form.parentId,
      domain: form.domain, modelIds: form.modelIds.split(',').map(s => s.trim()).filter(Boolean), expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null })
    secret.value = `一次性激活码（7天有效）：${result.code}`; await refresh()
  })
}
async function change(grant: LicenseGrant, status: string) {
  await perform(async () => { await centerRequest(`/grants/${encodeURIComponent(grant.id)}`, { status, expectedVersion: grant.version }, 'PATCH'); await refresh() })
}
async function renew(grant: LicenseGrant) {
  if (!renewal.value) { error.value = '请先选择新的到期时间'; return }
  await perform(async () => { await centerRequest(`/grants/${encodeURIComponent(grant.id)}`, { expiresAt: new Date(renewal.value).toISOString(), expectedVersion: grant.version }, 'PATCH'); await refresh() })
}
async function reissue(grant: LicenseGrant) {
  await perform(async () => { const result = await centerRequest<{ code: string }>(`/grants/${encodeURIComponent(grant.id)}/code`, {}); secret.value = `新激活码：${result.code}` })
}
async function publish() { await perform(async () => { await centerRequest('/packages', JSON.parse(packageJson.value)); await refresh() }) }
async function logout() { await perform(async () => { await centerLogout(); state.value = null }) }
</script>

<template>
  <main class="center-app">
    <header><span>YushuHub</span><h1>授权中心</h1><p>统一管理代理资格、功能套餐与部署绑定</p><button v-if="state" :disabled="busy" @click="logout">退出登录</button></header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <section v-if="secret" class="secret"><strong>请立即保存，离开后不再显示</strong><p>{{ secret }}</p><button @click="secret = ''">关闭</button></section>
    <form v-if="!state" @submit.prevent="signIn">
      <h2>运营登录</h2>
      <label>账号<input v-model="login.username" autocomplete="username" required /></label>
      <label>密码<input v-model="login.password" type="password" autocomplete="current-password" required /></label>
      <label>动态口令<input v-model="login.code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required /></label>
      <button :disabled="busy">{{ busy ? '正在验证…' : '登录' }}</button>
    </form>
    <template v-else>
      <form @submit.prevent="issue">
        <h2>签发授权</h2>
        <div class="fields">
          <label>代理名称<input v-model="form.name" maxlength="120" required /></label>
          <label>功能套餐<select v-model="form.package"><option v-for="pkg in state.packages" :key="`${pkg.id}:${pkg.version}`" :value="`${pkg.id}:${pkg.version}`">{{ pkg.id }} · v{{ pkg.version }}</option></select></label>
          <label v-if="selectedPackage?.level === 2">绑定一级<select v-model="form.parentId" required><option value="">选择已激活的一级</option><option v-for="parent in parents" :key="parent.id" :value="parent.id">{{ parent.name }}</option></select></label>
          <label v-else>备案域名<input v-model="form.domain" type="url" placeholder="https://agent.example.com" required /></label>
          <label>授权模型ID<input v-model="form.modelIds" placeholder="多个ID用英文逗号分隔" /></label>
          <label>到期时间<input v-model="form.expiresAt" type="datetime-local" /><small>留空表示无期限；二级受一级期限约束。</small></label>
        </div>
        <button :disabled="busy">签发并显示激活码</button>
      </form>
      <section>
        <h2>代理授权</h2><button :disabled="busy" @click="perform(refresh)">刷新</button>
        <label>续期目标时间<input v-model="renewal" type="datetime-local" /></label>
        <div class="table-scroll"><table><thead><tr><th>代理</th><th>套餐与层级</th><th>绑定</th><th>状态与期限</th><th>操作</th></tr></thead><tbody>
          <tr v-for="grant in state.grants" :key="grant.id"><td>{{ grant.name }}<small>{{ grant.id }}</small></td><td>{{ grant.packageId }} · v{{ grant.packageVersion }}<small>{{ grant.level }}级</small></td><td>{{ grant.domain }}<small>{{ grant.instanceId || '未激活' }}</small><small v-if="grant.parentId">上级：{{ grant.parentId }}</small></td><td>{{ grant.status }}<small>{{ grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : '无期限' }}</small></td><td><div class="actions"><button :disabled="busy || grant.status === 'revoked'" @click="change(grant, grant.status === 'enabled' ? 'suspended' : 'enabled')">{{ grant.status === 'enabled' ? '暂停' : '恢复' }}</button><button :disabled="busy || grant.status === 'revoked'" @click="renew(grant)">续期</button><button :disabled="busy || !!grant.instanceId" @click="reissue(grant)">重发激活码</button></div></td></tr>
        </tbody></table></div>
      </section>
      <section><h2>发布套餐新版本</h2><p>发布不修改现有代理授权，需通过授权变更接口显式应用。</p><label>套餐定义<textarea v-model="packageJson" rows="8" placeholder="粘贴新的套餐 JSON 定义" /></label><button :disabled="busy || !packageJson" @click="publish">发布不可变版本</button></section>
      <section><h2>审计记录</h2><ul><li v-for="event in state.audit" :key="event.id">{{ new Date(event.at).toLocaleString() }} · {{ event.actor }} · {{ event.event }} · {{ event.target }}</li></ul></section>
    </template>
  </main>
</template>

<style scoped>
.center-app{max-width:1200px;margin:0 auto;padding:32px;font:15px/1.6 system-ui;color:#1e293b}header{margin-bottom:28px}header>span{color:#2563eb}h1,h2{margin:0 0 12px}h1{font-size:30px}h2{font-size:20px}section,form{border:1px solid #dbe3ef;border-radius:14px;padding:24px;margin:20px 0;background:white}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}label{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}input,select,textarea{font:inherit;padding:10px;border:1px solid #b8c5d5;border-radius:7px;min-width:0}button{font:inherit;border:0;background:#1d4ed8;color:white;padding:9px 16px;border-radius:7px;cursor:pointer}button:disabled{opacity:.5;cursor:default}small{display:block;color:#64748b}.error{background:#fff1f2;color:#9f1239;padding:16px}.secret{background:#eff6ff;overflow-wrap:anywhere}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid #e2e8f0;vertical-align:top}.actions{display:flex;gap:6px;flex-wrap:wrap}li{padding:6px 0}@media(max-width:600px){.center-app{padding:16px}section,form{padding:16px}}
</style>
