<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { CloudCog, Database, KeyRound, Plus, RefreshCw, Trash2 } from '@lucide/vue'
import ModelServiceDrawer from '@/components/models/ModelServiceDrawer.vue'
import KeyUsageDrawer from '@/components/models/KeyUsageDrawer.vue'
import ModelKeyTable from '@/components/models/ModelKeyTable.vue'
import ProviderModelTable from '@/components/models/ProviderModelTable.vue'
import KeyVoicesDrawer from '@/components/models/KeyVoicesDrawer.vue'
import type { ModelProviderKey } from '@/types/model-service'
import ModelSearchToolbar from '@/components/models/ModelSearchToolbar.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { useModelServicePage, type ModelSection } from '@/composables/models/useModelServicePage'
const props = defineProps<{ section: ModelSection }>()
const section = toRef(props, 'section')
const model = useModelServicePage(section)
const { store, saving, testing, drawerOpen, errorMessage, form, meta, rows, keyProviderNav, keyGroups, modelProviderNav, modelGroups, canWrite, openCreate, openEdit, close, save, testConnection, disable, enable, remove, usageOpen, usageKey, usageLoading, usageError, usageRows, usagePagination, openUsage, closeUsage, setUsagePage, setUsagePageSize } = model
const voiceKey = ref<ModelProviderKey | null>(null)
const icon = computed(() => props.section === 'providers' ? CloudCog : props.section === 'keys' ? KeyRound : Database)
const selectedKeyProvider = computed(() => store.providers.find((item) => item.id === model.provider.value))
const selectedKeyProviderCount = computed(() => store.keys.filter((item) => item.providerId === model.provider.value).length)
const selectedModelProvider = computed(() => store.providers.find((item) => item.id === model.provider.value))
const selectedModelProviderCount = computed(() => store.models.filter((item) => item.providerId === model.provider.value).length)
function title(item: any) { return item.name || item.displayName || item.keyPreview || store.modelName(item.providerModelId) }
function subtitle(item: any) { return props.section === 'providers' ? item.baseUrl : props.section === 'keys' ? store.providerName(item.providerId) : props.section === 'catalog' ? `${store.providerName(item.providerId)} · ${item.modelId}` : `${item.providerName} · ${item.modelId}` }
function resolutionSummary(item: any) {
  const tiers = item.resolutionPoints || {}
  const parts = ['1K', '1.5K', '2K'].filter((tier) => Number(tiers[tier]) > 0).map((tier) => `${tier} ${tiers[tier]}`)
  return parts.length ? `${parts.join(' · ')} 积分/张` : '未配置分辨率价格'
}
function pricingSummary(item: any) {
  const multiplier = (value: unknown) => `${Number(value || 0).toFixed(2)}×`
  const consumption = `用户 ${multiplier(item.consumptionMultiplier ?? 1)}`
  if (item.billingType === 'per_request') return `${consumption} · 成本 ${item.costPointsPerRequest} · 销售 ${item.pointsPerRequest} · 售价/成本 ${multiplier(item.multipliers?.request)}`
  if (item.billingType === 'per_image_resolution') {
    const sales = item.resolutionPoints || {}, costs = item.resolutionCostPoints || {}, ratios = item.multipliers?.resolutions || {}
    return `${consumption} · ${['1K', '1.5K', '2K'].map((tier) => `${tier} 成本 ${costs[tier] || 0} / 销售 ${sales[tier] || 0} / 售价/成本 ${multiplier(ratios[tier])}`).join(' · ')}`
  }
  return `${consumption} · 输入 成本 ${item.inputCostPointsPerMTokens} / 销售 ${item.inputPointsPerMTokens} / 售价/成本 ${multiplier(item.multipliers?.input)} · 输出 成本 ${item.outputCostPointsPerMTokens} / 销售 ${item.outputPointsPerMTokens} / 售价/成本 ${multiplier(item.multipliers?.output)}`
}
</script>

<template><section class="management-page">
  <header class="page-heading management-heading"><div><span class="eyebrow">{{ meta.eyebrow }}</span><h1>{{ meta.title }}</h1><p>{{ meta.description }}</p></div><div class="heading-actions"><button class="secondary-button" :disabled="store.loading" @click="model.load"><RefreshCw :size="16" :class="{ spinning: store.loading }" />刷新</button><button v-if="canWrite" class="primary-button" :disabled="section === 'keys' && !store.providers.length" :title="section === 'keys' && !store.providers.length ? '请先创建服务商' : undefined" @click="openCreate"><Plus :size="17" />新建{{ meta.item }}</button></div></header>
  <ModelSearchToolbar :section="section" :model="model" />
  <div v-if="section === 'keys' || section === 'catalog'" class="key-pool-workspace">
    <nav class="key-provider-nav panel-card" :aria-label="section === 'keys' ? '按服务商筛选 Key' : '按服务商筛选模型'">
      <div class="key-provider-nav-heading"><strong>服务商</strong><span>{{ store.providers.length }}</span></div>
      <button v-for="item in section === 'keys' ? keyProviderNav : modelProviderNav" :key="item.id" type="button" class="key-provider-nav-item" :class="{ active: model.provider.value === item.id, orphan: item.missingProvider }" :aria-pressed="model.provider.value === item.id" @click="model.provider.value = item.id">
        <span class="key-provider-nav-copy"><strong>{{ item.name }}</strong><small v-if="item.missingProvider">服务商记录不存在</small></span><span class="key-provider-count">{{ item.count }}</span>
      </button>
    </nav>
    <div class="key-pool-content">
      <div v-if="store.loading && !(section === 'keys' ? store.keys.length : store.models.length)" class="table-panel panel-card table-loading">正在加载{{ section === 'keys' ? 'Key' : '模型' }}…</div>
      <template v-else-if="model.provider.value === 'all' && section === 'keys'">
        <div v-if="!keyGroups.length" class="table-panel panel-card key-pool-empty"><KeyRound :size="34" /><h2>{{ store.keys.length ? '没有匹配的 Key' : '暂无 Key' }}</h2><p>{{ store.providers.length ? '调整搜索关键词或状态筛选后重试。' : '请先到“模型服务商”创建服务商，再添加 Key。' }}</p></div>
        <details v-for="group in keyGroups" :key="group.id" class="key-provider-group panel-card">
          <summary><span><strong>{{ group.name }}</strong><small v-if="group.missingProvider">服务商记录不存在 · {{ group.id }}</small></span><span class="key-provider-count">{{ group.keys.length }} 个 Key</span></summary>
          <ModelKeyTable :models="store.models" :items="group.keys" :can-write="canWrite" @edit="openEdit" @usage="openUsage" @voices="voiceKey = $event" @disable="disable" @remove="remove" />
        </details>
      </template>
      <template v-else-if="model.provider.value === 'all'">
        <div v-if="!modelGroups.length" class="table-panel panel-card key-pool-empty"><Database :size="34" /><h2>{{ store.models.length ? '没有匹配的模型' : '暂无模型' }}</h2><p>{{ store.providers.length ? '调整搜索关键词、状态或类型筛选后重试。' : '请先创建服务商和模型。' }}</p></div>
        <details v-for="group in modelGroups" :key="group.id" class="key-provider-group panel-card">
          <summary><span><strong>{{ group.name }}</strong><small v-if="group.missingProvider">服务商记录不存在 · {{ group.id }}</small></span><span class="key-provider-count">{{ group.models.length }} 个模型</span></summary>
          <ProviderModelTable :items="group.models" :can-write="canWrite" @edit="openEdit" @disable="disable" @enable="enable" @remove="remove" />
        </details>
      </template>
      <section v-else-if="section === 'keys'" class="key-provider-detail panel-card">
        <header class="key-provider-detail-heading"><div><span class="eyebrow">Credential group</span><h2>{{ selectedKeyProvider?.name || keyProviderNav.find(item => item.id === model.provider.value)?.name || '未知服务商' }}</h2><p v-if="selectedKeyProvider">{{ selectedKeyProvider.protocol }} · {{ selectedKeyProvider.status === 'enabled' ? '启用' : '停用' }}</p><p v-else>服务商记录不存在 · {{ model.provider.value }}</p></div><span class="key-provider-count">{{ rows.length }} / {{ selectedKeyProviderCount }} 个 Key</span></header>
        <ModelKeyTable v-if="rows.length" :models="store.models" :items="rows" :can-write="canWrite" @edit="openEdit" @usage="openUsage" @voices="voiceKey = $event" @disable="disable" @remove="remove" />
        <div v-else class="key-provider-empty"><KeyRound :size="30" /><h3>{{ selectedKeyProviderCount ? '没有匹配的 Key' : '该服务商还没有 Key' }}</h3><p>{{ selectedKeyProviderCount ? '调整搜索关键词或状态筛选后重试。' : '新建的 Key 会自动归属到当前服务商。' }}</p><button v-if="canWrite && selectedKeyProvider && selectedKeyProvider.status !== 'disabled'" class="primary-button" @click="openCreate"><Plus :size="16" />新建 Key</button></div>
      </section>
      <section v-else class="key-provider-detail panel-card">
        <header class="key-provider-detail-heading"><div><span class="eyebrow">Model catalog</span><h2>{{ selectedModelProvider?.name || modelProviderNav.find(item => item.id === model.provider.value)?.name || '未知服务商' }}</h2><p v-if="selectedModelProvider">{{ selectedModelProvider.protocol }} · {{ selectedModelProvider.status === 'enabled' ? '启用' : '停用' }}</p><p v-else>服务商记录不存在 · {{ model.provider.value }}</p></div><span class="key-provider-count">{{ rows.length }} / {{ selectedModelProviderCount }} 个模型</span></header>
        <ProviderModelTable v-if="rows.length" :items="rows" :can-write="canWrite" @edit="openEdit" @disable="disable" @enable="enable" @remove="remove" />
        <div v-else class="key-provider-empty"><Database :size="30" /><h3>{{ selectedModelProviderCount ? '没有匹配的模型' : '该服务商还没有模型' }}</h3><p>{{ selectedModelProviderCount ? '调整搜索关键词、状态或类型筛选后重试。' : '新建的模型会自动归属到当前服务商。' }}</p><button v-if="canWrite && selectedModelProvider && selectedModelProvider.status !== 'disabled'" class="primary-button" @click="openCreate"><Plus :size="16" />新建模型</button></div>
      </section>
    </div>
  </div>
  <div v-else class="table-panel panel-card"><div v-if="store.loading && !rows.length" class="table-loading">正在加载…</div><div v-else-if="!rows.length" class="empty-state"><component :is="icon" :size="36" /><h2>暂无{{ meta.item }}</h2><p>使用右上角按钮创建第一条清晰、可追踪的配置。</p><button v-if="canWrite" class="primary-button" @click="openCreate"><Plus :size="17" />新建{{ meta.item }}</button></div><div v-else class="data-table-scroll"><table class="data-table model-table"><thead><tr><th>{{ meta.item }}</th><th>状态</th><th>配置摘要</th><th>更新时间</th><th class="action-column">操作</th></tr></thead><tbody><tr v-for="item in rows" :key="item.id"><td><div class="entity-cell"><span class="entity-avatar"><component :is="icon" :size="18" /></span><div><strong>{{ title(item) }}</strong><span>{{ subtitle(item) }}</span><small>{{ item.id }}</small><span v-if="item.isSystem" class="soft-tag system-tag">系统内置</span></div></div></td><td><StatusBadge :status="item.status" /></td><td><template v-if="section === 'providers'">{{ item.keyCount || 0 }} 个 Key · {{ item.modelCount || 0 }} 个模型</template><template v-else>{{ pricingSummary(item) }}</template></td><td><span class="date-cell">{{ item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN') : '—' }}</span></td><td class="action-column"><div class="row-actions"><button v-if="canWrite" class="text-button" @click="openEdit(item)">编辑</button><button v-if="canWrite && item.status !== 'disabled'" class="text-button" @click="disable(item)">停用</button><button v-if="canWrite && item.status === 'disabled'" class="text-button" @click="enable(item)">启用</button><button v-if="canWrite" class="icon-danger" title="永久删除" @click="remove(item)"><Trash2 :size="16" /></button></div></td></tr></tbody></table></div></div>
  <ModelServiceDrawer :open="drawerOpen" :section="section" :form="form" :providers="store.providers" :models="store.models" :saving="saving" :testing="testing" :error-message="errorMessage" @close="close" @save="save" @test="testConnection" />
  <KeyVoicesDrawer :open="Boolean(voiceKey)" :model-key="voiceKey" @close="voiceKey = null" />
  <KeyUsageDrawer :open="usageOpen" :usage="usageKey" :loading="usageLoading" :error-message="usageError" :rows="usageRows" :pagination="usagePagination" @close="closeUsage" @update:page="setUsagePage" @update:page-size="setUsagePageSize" />
</section></template>

<style scoped>
.system-tag { display: inline-flex; margin-top: 4px; color: var(--color-primary); }
</style>
