<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { api, toUserMessage } from '@/api/client'
const text = ref(''), busy = ref(false), error = ref(''), message = ref(''), restarting = ref(false), checking = ref(false)
const state = ref<{ configured: boolean; requiresRestart: boolean; authorizationStatus?: string; message?: string; connection?: { licenseId: string; publicUrl: string } | null } | null>(null)
const manual = reactive({ licenseId: '', centerUrl: 'https://license.okpa.cn', publicUrl: '', instanceId: '', publicKeys: '', activationCode: '' })
async function load() { checking.value = true; try { state.value = await api('/api/authorization/connection'); error.value = '' } catch(e) { error.value = toUserMessage(e); if (state.value?.configured) state.value = { ...state.value, authorizationStatus: 'unavailable', message: '当前无法核对授权状态，请稍后刷新。' } } finally { checking.value = false } }
function clearSecrets() { text.value = ''; manual.activationCode = '' }
function applied(scheduled: boolean, detail?: string) {
  clearSecrets(); restarting.value = scheduled
  message.value = scheduled ? '授权已激活，服务正在应用连接。请稍后刷新页面，必要时重新登录。' : detail || '授权已激活并保存，请应用连接以完成切换。'
}
async function activate(advanced = false) {
  busy.value = true; error.value = ''; message.value = ''
  try {
    const body = advanced ? { ...manual, publicKeys: JSON.parse(manual.publicKeys) } : { text: text.value.trim() }
    const result = await api<{ restartScheduled?: boolean; message?: string }>('/api/authorization/connection/activate', { method: 'POST', body: JSON.stringify(body) })
    applied(Boolean(result.restartScheduled), result.message); await load()
  } catch(e) { error.value = toUserMessage(e) } finally { busy.value = false }
}
async function restart() {
  busy.value = true; error.value = ''
  try { await api('/api/authorization/connection/restart', { method: 'POST', body: '{}' }); applied(true) }
  catch(e) { error.value = toUserMessage(e) } finally { busy.value = false }
}
onMounted(load); onUnmounted(clearSecrets)
</script>
<template>
  <article class="panel-card">
    <h2>接入独立授权中心</h2>
    <p>新部署或旧授权迁移，都只需向授权人员获取一段接入信息，粘贴后激活。接入失败不会改写原连接或经营数据。</p>
    <p v-if="checking" role="status">正在核对授权状态…</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <template v-if="state?.configured">
      <p>已接入授权：{{ state.connection?.licenseId }}</p><p>绑定地址：{{ state.connection?.publicUrl }}</p>
      <p v-if="state.authorizationStatus === 'active'">授权有效，连接已应用。续期和套餐调整会自动同步。</p>
      <p v-else-if="state.authorizationStatus === 'invalid'" role="alert">{{ state.message || '原授权已失效，可粘贴同一部署的新接入信息重新授权。' }}</p>
      <p v-else-if="state.authorizationStatus === 'unavailable'">{{ state.message }}</p>
      <button v-if="state.requiresRestart" class="primary-button" :disabled="busy || restarting" @click="restart">{{ restarting ? '正在应用连接…' : '应用连接并重启服务' }}</button>
      <button v-else type="button" class="secondary-button" :disabled="busy || checking" @click="load">重新核对授权</button>
    </template>
    <template v-if="state && (!state.configured || state.authorizationStatus === 'invalid')">
      <p v-if="state.configured">重新授权会接续原有业务身份、历史项目和累计用量，不会重建或清空经营数据。</p>
      <form @submit.prevent="activate()">
        <label class="connection-field">授权接入信息<textarea v-model="text" rows="5" autocomplete="off" spellcheck="false" placeholder="在此粘贴授权人员提供的整段 YUSHU1. 接入信息" :disabled="busy" required /></label>
        <button class="primary-button" :disabled="busy || !text.trim()">{{ busy ? '正在验证并激活…' : state.configured ? '重新授权并应用' : '激活并应用' }}</button>
      </form>
      <details><summary>高级设置（手动填写）</summary>
        <form @submit.prevent="activate(true)"><fieldset :disabled="busy">
          <label class="connection-field">授权ID<input v-model="manual.licenseId" required /></label>
          <label class="connection-field">中心地址<input v-model="manual.centerUrl" type="url" required /></label>
          <label class="connection-field">后台HTTPS地址<input v-model="manual.publicUrl" type="url" required /></label>
          <label class="connection-field">实例ID<input v-model="manual.instanceId" required /></label>
          <label class="connection-field">签名公钥集合<textarea v-model="manual.publicKeys" rows="3" required /></label>
          <label class="connection-field">一次性激活码<input v-model="manual.activationCode" type="password" autocomplete="off" required /></label>
          <button class="primary-button">验证并激活</button>
        </fieldset></form>
      </details>
    </template>
  </article>
</template>
<style scoped>
.connection-field { display: grid; gap: 6px; margin-block: 12px; min-width: 0; }
.connection-field textarea, .connection-field input { width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; padding: 12px; color: var(--text); font: inherit; line-height: 1.6; background: #fff; border: 1px solid var(--border); border-radius: 10px; }
.connection-field textarea:focus, .connection-field input:focus { outline: 2px solid var(--brand); outline-offset: 2px; }
.panel-card [role=alert] { color: #b91c1c; }
.panel-card [role=status] { padding: 12px; background: #eef2ff; border-radius: 10px; }
fieldset { min-width: 0; padding: 0; border: 0; }
.connection-field textarea { resize: vertical; overflow-wrap: anywhere; }
summary { cursor: pointer; margin-top: 16px; }
</style>
