<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { CircleDollarSign, Pencil, Plus, RefreshCw, Trash2 } from '@lucide/vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import PricingPlanDrawer from '@/components/models/PricingPlanDrawer.vue'
import { useFeedbackStore } from '@/stores/feedback'
import * as api from '@/api/pricing-center'
import { listModelProviders } from '@/api/model-service'
import type { ModelProvider } from '@/types/model-service'
import type { ModelCapability, PricingComponent, PricingGroup, PricingMeter, PricingPlan } from '@/types/pricing-center'

const props = defineProps<{ group: PricingGroup }>()
const feedback = useFeedbackStore()
const labels: Record<PricingGroup, { title: string; description: string; tasks: string[] }> = {
  text: { title: '文本与搜索', description: '按输入、输出、缓存 Token 或请求次数组合计费。', tasks: ['chat', 'web_search'] },
  image: { title: '图片', description: '按张数、分辨率和质量维护成本与售价。', tasks: ['image_generation', 'image_edit'] },
  audio: { title: '语音与音频', description: '支持试听、首次启用、字符和音频时长计费。', tasks: ['speech_synthesis', 'speech_recognition'] },
  video: { title: '视频', description: '视频模型协议与计费能力正在开发。', tasks: ['video_generation'] },
  vector: { title: '向量与重排', description: '向量和重排模型能力正在开发。', tasks: ['embedding', 'rerank'] },
}
const meterLabels: Record<PricingMeter, string> = { request: '请求次数', input_tokens: '输入 Token', output_tokens: '输出 Token', cached_tokens: '缓存 Token', image: '输出图片', additional_input_images: '额外参考图（首张免费）', billable_characters: '可计费字符', audio_seconds: '音频秒数', video_seconds: '视频秒数', vector_inputs: '向量条数', resource_activation: '资源首次启用' }
const plans = ref<PricingPlan[]>([]), capabilities = ref<ModelCapability[]>([])
const providers = ref<ModelProvider[]>([]), provider = ref('all')
const providerNav = computed(() => {
  const items = new Map(providers.value.map(item => [item.id, { id: item.id, name: item.name, count: 0 }]))
  for (const plan of plans.value) {
    const item = items.get(plan.providerId) || { id: plan.providerId, name: plan.providerName || `未知服务商 · ${plan.providerId}`, count: 0 }
    item.count++
    items.set(item.id, item)
  }
  return [...items.values()]
})
const filteredPlans = computed(() => props.group !== 'text' || provider.value === 'all' ? plans.value : plans.value.filter(item => item.providerId === provider.value))
const loading = ref(false), saving = ref(false), error = ref(''), drawer = ref(false)
const form = reactive<{ sourcePlanId: string; capabilityId: string; status: 'draft' | 'enabled'; consumptionMultiplier: number; components: PricingComponent[] }>({ sourcePlanId: '', capabilityId: '', status: 'enabled', consumptionMultiplier: 1, components: [] })
const meta = computed(() => labels[props.group])
const availableCapabilities = computed(() => capabilities.value.filter(item => (props.group !== 'text' || provider.value === 'all' || item.providerId === provider.value) && !plans.value.some(plan => plan.capabilityId === item.id) && item.status === 'enabled' && (!meta.value.tasks.length || meta.value.tasks.includes(item.taskType))))
const drawerCapabilities = computed(() => form.sourcePlanId ? capabilities.value : availableCapabilities.value)
const selectedCapability = computed(() => capabilities.value.find(item => item.id === form.capabilityId))
const enabledCount = computed(() => filteredPlans.value.filter(item => item.status === 'enabled').length)
const isComingSoon = computed(() => props.group === 'video' || props.group === 'vector')

function component(meter: PricingMeter, phase: PricingComponent['phase'] = 'usage', unitSize = 1, dimensions: Record<string, string> = {}): PricingComponent {
  return { meter, phase, unitSize, minimumUnits: 0, rounding: 'none', dimensions, costAmount: 0, costCurrency: 'CNY', salePoints: 0, status: 'enabled' }
}
function defaults(task = ''): PricingComponent[] {
  if (['chat', 'web_search'].includes(task)) return [component('input_tokens', 'usage', 1_000_000), component('cached_tokens', 'usage', 1_000_000), component('output_tokens', 'usage', 1_000_000)]
  if (task === 'rerank') return [component('input_tokens', 'usage', 1_000_000)]
  if (task.startsWith('image_')) return [...['1K', '1.5K', '2K'].map(resolution => component('image', 'usage', 1, { resolution })), component('additional_input_images')]
  if (task === 'speech_synthesis') return [component('billable_characters', 'preview', 1000), component('resource_activation', 'activation'), component('billable_characters', 'usage', 1000)]
  if (task === 'speech_recognition') return [component('audio_seconds', 'usage', 60, {},)]
  if (task === 'video_generation') return [component('video_seconds', 'usage', 1, { resolution: '720p' })]
  if (task === 'embedding') return [component('input_tokens', 'usage', 1_000_000), component('vector_inputs')]
  return [component('request', 'request')]
}
async function load() { if (isComingSoon.value) { plans.value = []; capabilities.value = []; return }; loading.value = true; error.value = ''; try { [plans.value, capabilities.value, providers.value] = await Promise.all([api.listPricingPlans(props.group), api.listModelCapabilities(), props.group === 'text' ? listModelProviders() : Promise.resolve([])]); if (provider.value !== 'all' && !providerNav.value.some(item => item.id === provider.value)) provider.value = 'all' } catch (e) { error.value = e instanceof Error ? e.message : String(e) } finally { loading.value = false } }
function openCreate() { form.sourcePlanId = ''; form.capabilityId = availableCapabilities.value[0]?.id || ''; form.status = 'enabled'; form.consumptionMultiplier = 1; form.components = defaults(availableCapabilities.value[0]?.taskType); drawer.value = true }
function edit(plan: PricingPlan) { form.sourcePlanId = plan.id; form.capabilityId = plan.capabilityId; form.status = plan.status === 'draft' ? 'draft' : 'enabled'; form.consumptionMultiplier = plan.consumptionMultiplier ?? 1; form.components = plan.components.map(item => ({ ...item, dimensions: { ...item.dimensions } })); drawer.value = true }
function addComponent() { form.components.push(component('request', 'request')) }
function removeComponent(index: number) { form.components.splice(index, 1) }
const meterOptions = computed(() => {
  const task = selectedCapability.value?.taskType || ''
  const allowed: Record<string, PricingMeter[]> = { chat: ['request','input_tokens','cached_tokens','output_tokens'], web_search: ['request','input_tokens','cached_tokens','output_tokens'], rerank: ['request','input_tokens'], image_generation: ['request','image','additional_input_images'], image_edit: ['request','image','additional_input_images'], speech_synthesis: ['request','billable_characters','audio_seconds','resource_activation'], speech_recognition: ['request','audio_seconds'], video_generation: ['request','video_seconds'], embedding: ['request','input_tokens','vector_inputs'] }
  return allowed[task] || ['request']
})
function resetMeter(item: PricingComponent) { item.dimensions = item.meter === 'image' ? { resolution: '1K' } : item.meter === 'video_seconds' ? { resolution: '720p', quality: 'standard' } : {}; item.phase = item.meter === 'request' ? 'request' : item.meter === 'resource_activation' ? 'activation' : 'usage' }
function unitLabel(item: PricingComponent) { if (['input_tokens','output_tokens','cached_tokens'].includes(item.meter)) return '每百万 Token'; if (item.meter === 'billable_characters') return '每千计费字符'; if (item.meter === 'audio_seconds') return '每分钟'; if (item.meter === 'image') return '每张'; if (item.meter === 'additional_input_images') return '每张额外参考图'; if (item.meter === 'resource_activation' || item.meter === 'request') return '每次'; return '每单位' }
function formatConsumptionMultiplier(value: unknown) { const number = Number(value); return (Number.isFinite(number) && number >= 0 ? number : 1).toFixed(2) }
async function save() { if (!selectedCapability.value || !form.components.length) return; saving.value = true; error.value = ''; try { await api.savePricingPlan({ sourcePlanId: form.sourcePlanId || undefined, capabilityId: selectedCapability.value.id, taskType: selectedCapability.value.taskType, status: form.status, consumptionMultiplier: form.consumptionMultiplier, components: form.components }); drawer.value = false; await load() } catch (e) { error.value = e instanceof Error ? e.message : String(e) } finally { saving.value = false } }
async function toggle(plan: PricingPlan) { await api.setPricingPlanStatus(plan.id, plan.status === 'enabled' ? 'disabled' : 'enabled'); await load() }
function protectedPlan(plan: PricingPlan) { return plan.isProtected }
async function remove(plan: PricingPlan) { if (protectedPlan(plan)) { feedback.notify('系统内置图片或音频方案不可删除，可直接编辑报价', 'warning'); return }; const accepted = await feedback.confirm({ title: `永久删除 ${plan.displayName} 计费方案？`, message: '删除后无法恢复，历史计费记录仍保留原价格快照。', confirmText: '永久删除', tone: 'danger' }); if (!accepted) return; try { await api.deletePricingPlan(plan.id); await load(); feedback.notify('计费方案已删除', 'success') } catch (e) { feedback.notify(e instanceof Error ? e.message : String(e), 'error') } }
watch(() => form.capabilityId, value => { const task = capabilities.value.find(item => item.id === value)?.taskType; if (drawer.value && !form.sourcePlanId && task) form.components = defaults(task) })
watch(() => props.group, () => { provider.value = 'all'; load() })
onMounted(load)
</script>

<template><section class="management-page pricing-center">
  <header class="page-heading management-heading"><div><span class="eyebrow">统一计费中心</span><h1>{{ meta.title }}</h1><p>{{ meta.description }}</p></div><div v-if="!isComingSoon" class="heading-actions"><button class="secondary-button" :disabled="loading" @click="load"><RefreshCw :size="16" :class="{ spinning: loading }" />刷新</button><button class="primary-button" :disabled="!availableCapabilities.length" @click="openCreate"><Plus :size="17" />新建方案</button></div></header>
  <div v-if="error" class="inline-alert error-alert">{{ error }}</div>
  <div v-if="isComingSoon" class="panel-card coming-soon"><span class="entity-avatar"><CircleDollarSign :size="22" /></span><h2>功能开发中</h2><p>{{ group === 'video' ? '视频模型调用和计费将在厂商协议接入完成后开放。' : '向量与重排模型将在统一调用链完成后开放。' }}</p><small>当前页面不接受配置，避免产生无法执行的计费方案。</small></div>
  <template v-else><div :class="{ 'key-pool-workspace': group === 'text' }">
    <nav v-if="group === 'text'" class="key-provider-nav panel-card" aria-label="按服务商筛选计费方案">
      <div class="key-provider-nav-heading"><strong>服务商</strong><span>{{ providerNav.length }}</span></div>
      <button type="button" class="key-provider-nav-item" :class="{ active: provider === 'all' }" :aria-pressed="provider === 'all'" @click="provider = 'all'"><span class="key-provider-nav-copy"><strong>全部服务商</strong></span><span class="key-provider-count">{{ plans.length }}</span></button>
      <button v-for="item in providerNav" :key="item.id" type="button" class="key-provider-nav-item" :class="{ active: provider === item.id }" :aria-pressed="provider === item.id" @click="provider = item.id"><span class="key-provider-nav-copy"><strong>{{ item.name }}</strong></span><span class="key-provider-count">{{ item.count }}</span></button>
    </nav>
    <div class="key-pool-content"><div class="pricing-metrics"><article class="panel-card"><span>方案总数</span><strong>{{ filteredPlans.length }}</strong></article><article class="panel-card"><span>生效方案</span><strong>{{ enabledCount }}</strong></article></div>
<div class="table-panel panel-card"><div v-if="loading && !plans.length" class="table-loading">正在加载计费方案…</div><div v-else-if="!filteredPlans.length" class="empty-state"><CircleDollarSign :size="36" /><h2>{{ group === 'text' && provider !== 'all' ? '该服务商暂无计费方案' : '暂无计费方案' }}</h2><p>先为模型配置明确的任务能力，再创建由多个计费项组成的方案。</p></div><div v-else class="data-table-scroll"><table class="data-table"><thead><tr><th>模型与任务</th><th>消费倍率</th><th>计费项</th><th>状态</th><th>更新时间</th><th class="action-column">操作</th></tr></thead><tbody><tr v-for="plan in filteredPlans" :key="plan.id"><td><div class="entity-cell"><span class="entity-avatar"><CircleDollarSign :size="18" /></span><div><strong>{{ plan.displayName }}</strong><span>{{ plan.providerName }} · {{ plan.taskType }}</span><small>{{ plan.modelId }}</small><span v-if="protectedPlan(plan)" class="soft-tag system-tag">系统内置 · 可编辑不可删除</span></div></div></td><td>{{ formatConsumptionMultiplier(plan.consumptionMultiplier) }}×</td><td><div class="component-summary"><span v-for="item in plan.components" :key="item.id">{{ meterLabels[item.meter] }} · {{ item.salePoints }} 积分（{{ unitLabel(item) }}）</span></div></td><td><StatusBadge :status="plan.status" /></td><td><span class="date-cell">{{ plan.updatedAt ? new Date(plan.updatedAt).toLocaleString('zh-CN') : '—' }}</span></td><td class="action-column"><div class="row-actions"><button class="text-button" @click="edit(plan)"><Pencil :size="14" />编辑报价</button><button class="text-button" @click="toggle(plan)">{{ plan.status === 'enabled' ? '停用' : '启用' }}</button><button v-if="!protectedPlan(plan)" class="icon-danger" title="永久删除" @click="remove(plan)"><Trash2 :size="16" /></button></div></td></tr></tbody></table></div></div></div></div></template>
<PricingPlanDrawer :open="drawer" :saving="saving" :form="form" :capabilities="drawerCapabilities" :selected-capability="selectedCapability" :meter-options="meterOptions" :meter-labels="meterLabels" @close="drawer=false" @save="save" @add-component="addComponent" @remove-component="removeComponent" @reset-meter="resetMeter" />
</section></template>

<style scoped>
.pricing-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.pricing-metrics article{display:flex;flex-direction:column;gap:8px;padding:18px}.pricing-metrics span{color:var(--color-text-secondary);font-size:13px}.pricing-metrics strong{font-size:26px}.component-summary{display:flex;flex-direction:column;gap:4px;font-size:12px}.row-actions{display:flex;align-items:center;gap:5px}.cell-note{display:block;margin-top:4px}.coming-soon{display:grid;min-height:420px;place-content:center;justify-items:center;text-align:center}.coming-soon h2{margin:16px 0 6px;font-size:21px}.coming-soon p{margin:0;color:var(--color-text-secondary)}.coming-soon small{margin-top:8px;color:var(--color-text-tertiary)}@media(max-width:900px){.pricing-metrics{grid-template-columns:1fr}}
</style>
