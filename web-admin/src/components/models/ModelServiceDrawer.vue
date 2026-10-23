<script setup lang="ts">
import { FlaskConical, ShieldCheck, X } from '@lucide/vue'
import type { ModelSection } from '@/composables/models/useModelServicePage'
import ModelKeyForm from './ModelKeyForm.vue'
import ModelCatalogForm from './ModelCatalogForm.vue'
import type { ModelProvider, ProviderModel } from '@/types/model-service'
const props = defineProps<{ open: boolean; section: ModelSection; form: Record<string, any>; providers: ModelProvider[]; models: ProviderModel[]; saving: boolean; testing: boolean; errorMessage: string }>()
defineEmits<{ close: []; save: []; test: [] }>()
function priceMultiplier(sale: unknown, cost: unknown): string {
  const saleNumber = Number(sale || 0), costNumber = Number(cost || 0)
  if (!Number.isFinite(saleNumber) || !Number.isFinite(costNumber) || costNumber <= 0) return '0.00×'
  return `${(saleNumber / costNumber).toFixed(2)}×`
}
</script>

<template>
  <div v-if="open" class="drawer-backdrop-v2"><aside class="form-drawer-v2 model-drawer" role="dialog" aria-modal="true">
    <header class="drawer-header"><div><span class="eyebrow">Secure configuration</span><h2>{{ form.id ? '编辑配置' : '新建配置' }}</h2></div><button class="icon-button" :disabled="saving || testing" aria-label="关闭" @click="$emit('close')"><X :size="18" /></button></header>
    <div class="drawer-body"><section class="form-section"><div class="section-heading"><span><ShieldCheck :size="15" /></span><div><h3>配置详情</h3><p>敏感数据保存后只显示脱敏结果。</p></div></div>
      <template v-if="section === 'providers'"><div class="form-grid-v2"><label><span>服务商 ID</span><input v-model.trim="form.id" :disabled="Boolean(form.id)" placeholder="可留空自动生成" /></label><label><span>服务商名称</span><input v-model.trim="form.name" /></label></div><label><span>API 基础地址</span><input v-model.trim="form.baseUrl" placeholder="https://api.example.com/v1" /></label><div class="form-grid-v2"><label><span>超时（毫秒）</span><input v-model.number="form.timeoutMs" type="number" min="10000" /></label><label><span>排序</span><input v-model.number="form.sortOrder" type="number" /></label></div><label><span>备注</span><textarea v-model.trim="form.notes" rows="3" /></label><label class="switch-row"><span><strong>设为默认服务商</strong><small>同一时间仅一个默认项</small></span><input v-model="form.isDefault" type="checkbox" /></label></template>
      <ModelKeyForm v-else-if="section === 'keys'" :form="form" :providers="providers" :models="models" />
      <ModelCatalogForm v-else-if="section === 'catalog'" :form="form" :providers="providers" />
      <template v-else>
        <label><span>计费模型</span><select v-model="form.providerModelId"><option v-for="item in models" :key="item.id" :value="item.id">{{ item.providerName }} · {{ item.displayName }}</option></select></label>
        <label><span>计费方式</span><select v-model="form.billingType"><option value="per_token">按 Token</option><option value="per_request">按次</option><option value="per_image_resolution">按图片分辨率</option></select></label>
        <div v-if="form.billingType === 'per_token'" class="pricing-editor">
          <div class="pricing-head"><span>计费项</span><span>成本价</span><span>销售价</span><span>售价/成本</span></div>
          <div class="pricing-row"><strong>输入 / 百万 Token</strong><input v-model.number="form.inputCostPointsPerMTokens" type="number" min="0" step="0.000001" /><input v-model.number="form.inputPointsPerMTokens" type="number" min="0" step="0.000001" /><output>{{ priceMultiplier(form.inputPointsPerMTokens, form.inputCostPointsPerMTokens) }}</output></div>
          <div class="pricing-row"><strong>输出 / 百万 Token</strong><input v-model.number="form.outputCostPointsPerMTokens" type="number" min="0" step="0.000001" /><input v-model.number="form.outputPointsPerMTokens" type="number" min="0" step="0.000001" /><output>{{ priceMultiplier(form.outputPointsPerMTokens, form.outputCostPointsPerMTokens) }}</output></div>
        </div>
        <div v-else-if="form.billingType === 'per_request'" class="pricing-editor">
          <div class="pricing-head"><span>计费项</span><span>成本价</span><span>销售价</span><span>售价/成本</span></div>
          <div class="pricing-row"><strong>每次请求</strong><input v-model.number="form.costPointsPerRequest" type="number" min="0" step="0.000001" /><input v-model.number="form.pointsPerRequest" type="number" min="0" step="0.000001" /><output>{{ priceMultiplier(form.pointsPerRequest, form.costPointsPerRequest) }}</output></div>
        </div>
        <div v-else-if="form.billingType === 'per_image_resolution'" class="pricing-editor">
          <div class="pricing-head"><span>计费项</span><span>成本价</span><span>销售价</span><span>售价/成本</span></div>
          <div v-for="tier in ['1K', '1.5K', '2K']" :key="tier" class="pricing-row"><strong>{{ tier }} / 张</strong><input v-model.number="form.resolutionCostPoints[tier]" type="number" min="0" step="0.000001" /><input v-model.number="form.resolutionPoints[tier]" type="number" min="0" step="0.000001" /><output>{{ priceMultiplier(form.resolutionPoints[tier], form.resolutionCostPoints[tier]) }}</output></div>
        </div>
        <label class="consumption-multiplier-field"><span>用户消费倍率<small>以平台常用模型为 1.00×，可填 0.00，便宜一半可填 0.50，贵一倍可填 2.00；保留两位小数，仅用于客户端价格感知。</small></span><input v-model.number="form.consumptionMultiplier" type="number" min="0" step="0.01" /></label>
        <small class="pricing-hint">价格单位均为积分；用户扣费仍按销售价计算，销售价为 0 时显示“免费体验”。</small>
      </template>
      <p v-if="errorMessage" class="drawer-error" role="alert">{{ errorMessage }}</p>
    </section></div>
    <footer class="drawer-footer"><button v-if="section === 'catalog'" class="secondary-button" :disabled="saving || testing" @click="$emit('test')"><FlaskConical :size="16" />{{ testing ? '测试中…' : '测试连接' }}</button><button class="primary-button" :disabled="saving || testing" @click="$emit('save')">{{ saving ? '保存中…' : '保存配置' }}</button></footer>
  </aside></div>
</template>

<style scoped>
.pricing-editor { display: grid; gap: 8px; margin-bottom: 10px; padding: 12px; border: 1px solid var(--color-border-soft); border-radius: 10px; background: var(--color-surface-2); }
.pricing-head, .pricing-row { display: grid; grid-template-columns: minmax(130px, 1.4fr) repeat(2, minmax(96px, 1fr)) 72px; align-items: center; gap: 10px; }
.pricing-head { color: var(--color-text-tertiary); font-size: 11px; }
.pricing-row strong { color: var(--color-text-secondary); font-size: 12px; }
.pricing-row input { width: 100%; min-width: 0; }
.pricing-row output { color: var(--color-primary); font-weight: 700; text-align: right; }
.pricing-hint { display: block; margin: -2px 0 8px; color: var(--color-text-tertiary); }
.consumption-multiplier-field { display: grid; grid-template-columns: minmax(0, 1fr) 128px; align-items: center; gap: 12px; margin: 2px 0 10px; padding: 12px; border: 1px solid var(--color-border-soft); border-radius: 10px; background: var(--color-surface-2); }
.consumption-multiplier-field > span { display: grid; gap: 3px; color: var(--color-text-primary); font-size: 13px; font-weight: 650; }
.consumption-multiplier-field small { color: var(--color-text-tertiary); font-size: 11px; font-weight: 400; line-height: 1.45; }
@media (max-width: 720px) { .pricing-head { display: none; } .pricing-row { grid-template-columns: 1fr 1fr; } .pricing-row strong { grid-column: 1 / -1; } .pricing-row output { text-align: left; } }
</style>
