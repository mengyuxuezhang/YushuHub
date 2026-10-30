<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { centerRequest } from '@/api/license-center'
interface NotificationState {
  config: { version: number; enabled: boolean; configured: boolean; host: string | null }
  lastScanAt: number | null; lastScanError: { code: string } | null
  deliveries: { id: string; kind: string; state: string; attempts: number; lastError?: string }[]
}
const state = ref<NotificationState | null>(null), busy = ref(false), error = ref('')
const form = reactive({ enabled: false, url: '', signingSecret: '' })
async function load() { state.value = await centerRequest<NotificationState>('/notifications', undefined, 'GET'); form.enabled = state.value.config.enabled }
async function perform(operation: () => Promise<unknown>) {
  busy.value = true; error.value = ''
  try { await operation() } catch (e) { error.value = e instanceof Error ? e.message : '操作失败' } finally { busy.value = false }
}
async function save() {
  await perform(async () => {
    await centerRequest('/notifications/config', { expectedVersion: state.value!.config.version, enabled: form.enabled,
      ...(form.url ? { url: form.url, signingSecret: form.signingSecret } : {}) }, 'PUT')
    form.url = ''; form.signingSecret = ''; await load()
  })
}
async function test() { await perform(async () => { await centerRequest('/notifications/test', { requestId: crypto.randomUUID() }); await centerRequest('/notifications/scan', {}); await load() }) }
onMounted(() => perform(load))
</script>
<template>
  <section aria-label="到期提醒通知">
    <h2>到期提醒</h2><p>到期前30、7、1天进入对应提醒窗口；重试不会创建新的提醒事件。投递失败会保留并重试。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="state">
      <p>通知地址：{{ state.config.configured ? state.config.host : '未配置' }}；最近扫描：{{ state.lastScanAt ? new Date(state.lastScanAt).toLocaleString() : '尚未扫描' }}；{{ state.lastScanError?.code || '扫描无异常' }}。</p>
      <form @submit.prevent="save">
        <label><input v-model="form.enabled" type="checkbox" />启用飞书 Webhook</label>
        <label>更换通知地址<input v-model="form.url" type="password" autocomplete="new-password" placeholder="留空保留已有地址" /></label>
        <label>机器人签名密钥<input v-model="form.signingSecret" type="password" autocomplete="new-password" placeholder="更换地址时填写；未启用签名则留空" /></label>
        <button :disabled="busy">保存配置</button><button type="button" :disabled="busy || !state.config.enabled" @click="test">发送通道测试</button><button type="button" :disabled="busy" @click="perform(load)">刷新状态</button>
      </form>
      <ul><li v-for="event in state.deliveries" :key="event.id">{{ event.kind }} · {{ event.state }} · 尝试 {{ event.attempts }} 次 {{ event.lastError || '' }}</li></ul>
    </template>
  </section>
</template>
<style scoped>
section{border:1px solid #dbe3ef;border-radius:14px;padding:24px;margin:20px 0;background:white}h2{font-size:20px}label{display:flex;gap:8px;margin:12px 0;align-items:center;flex-wrap:wrap}input{font:inherit;padding:8px;border:1px solid #b8c5d5;border-radius:7px}button{font:inherit;border:0;background:#1d4ed8;color:white;padding:9px 16px;border-radius:7px;margin:4px;cursor:pointer}button:disabled{opacity:.5}li{overflow-wrap:anywhere}[role=alert]{color:#9f1239}
</style>
