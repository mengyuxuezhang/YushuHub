<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '@/api/client'
const props = defineProps<{ mode: 'price' | 'accounting' }>()
const endpoint = computed(() => props.mode === 'price' ? '/api/supply/notifications' : '/api/authorization/monitor')
interface ChannelState {
  config: { version: number; enabled: boolean; configured: boolean; host: string | null }
  lastScanError?: { code: string } | null; lastPriceScanAt?: number | null; lastPriceScanError?: { code: string } | null; noticeBacklog?: number
  deliveries: { id: string; kind: string; state: string; attempts: number; lastError?: string }[]
  metrics?: { cashPending?: number; cashUnknown?: number; cashAuditMismatches?: number; cashOldestAgeMs?: number; checkedAt?: number } | null
}
const state = ref<ChannelState | null>(null), error = ref(''), message = ref(''), busy = ref(false)
const form = reactive({ enabled: false, url: '', signingSecret: '' })
async function load() { state.value = await api<ChannelState>(endpoint.value); form.enabled = state.value.config.enabled }
async function perform(work: () => Promise<unknown>) {
  busy.value = true; error.value = ''; message.value = ''
  try { await work() } catch (e) { error.value = e instanceof Error ? e.message : '通知配置操作失败' } finally { busy.value = false }
}
async function save() {
  await perform(async () => {
    await api(`${endpoint.value}/config`, { method: 'PUT', body: JSON.stringify({ enabled: form.enabled, expectedVersion: state.value!.config.version,
      ...(form.url ? { url: form.url, signingSecret: form.signingSecret } : {}) }) })
    form.url = ''; form.signingSecret = ''; await load(); message.value = '通知配置已保存，原告警阈值保留。'
  })
}
async function test() {
  await perform(async () => { await api(`${endpoint.value}/test`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) }); await load(); message.value = '通道测试已入队，将在下一轮发送。' })
}
onMounted(() => perform(load))
</script>
<template>
  <article class="panel-card notifications-card">
    <h2>{{ mode === 'price' ? '本组织调价通知' : '一级资金与授权告警' }}</h2>
    <p>{{ mode === 'price' ? '本组织所有者独立配置接收地址；与一级资金告警分开保存。价表先公开，Webhook投递失败会重试并显示状态。' : '仅一级组织所有者管理，接收资金守恒、待对账、预占和授权同步异常。' }}</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <template v-if="state">
      <p>通知地址：{{ state.config.configured ? state.config.host : '未配置' }} · {{ state.config.enabled ? '已启用' : '已停用' }}</p>
      <p v-if="mode === 'accounting' && state.metrics?.cashPending !== undefined">现金退款：待处理 {{ state.metrics.cashPending }} 笔，结果未知 {{ state.metrics.cashUnknown || 0 }} 笔，账务核对异常 {{ state.metrics.cashAuditMismatches || 0 }} 笔；最早受理已等待 {{ Math.floor((state.metrics.cashOldestAgeMs || 0) / 60000) }} 分钟。数据按巡检批次更新，不能代替支付平台最终账单。</p>
      <p v-if="state.lastPriceScanAt">最近价表扫描 {{ new Date(state.lastPriceScanAt).toLocaleString() }} · 积压 {{ state.noticeBacklog || 0 }} 条</p>
      <p v-if="state.lastPriceScanError || state.lastScanError" role="alert">{{ state.lastPriceScanError?.code === 'LICENSE_INACTIVE' ? '授权当前不可用，历史通知保留；恢复后继续扫描价表。' : '通知扫描失败，请检查授权、数据库和上游连接。' }}</p>
      <form @submit.prevent="save">
        <label><input v-model="form.enabled" type="checkbox" />启用飞书 Webhook</label>
        <label>更换地址<input v-model="form.url" type="password" autocomplete="new-password" placeholder="留空保留现有地址" /></label>
        <label>签名密钥<input v-model="form.signingSecret" type="password" autocomplete="new-password" placeholder="更换地址时填写；无签名则留空" /></label>
        <button class="primary-button" :disabled="busy">保存通知配置</button><button type="button" class="secondary-button" :disabled="busy || !state.config.enabled" @click="test">发送通道测试</button><button type="button" class="secondary-button" :disabled="busy" @click="perform(load)">刷新通知状态</button>
      </form>
      <ul><li v-for="event in state.deliveries" :key="event.id">{{ event.kind }} · {{ event.state }} · 尝试 {{ event.attempts }} 次 {{ event.lastError || '' }}</li></ul>
    </template>
  </article>
</template>
<style scoped>
.notifications-card{padding:24px;margin:18px 0}.notifications-card label{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0}.notifications-card input{padding:8px}.notifications-card button{margin:4px}.notifications-card li{overflow-wrap:anywhere}
</style>
