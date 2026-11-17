<script setup lang="ts">
import { computed } from 'vue'
import { imageBillingMode, imagePricingComponents, type ImageBillingMode } from '@/utils/image-pricing'
import { Plus, X } from '@lucide/vue'
import { formatPoints, formatUnitPriceCny, pointsFromSalePrice } from '@/utils/pricing-points'
import type { MembershipPricingOption, ModelCapability, PricingComponent, PricingMeter } from '@/types/pricing-center'

const props = defineProps<{
  open: boolean
  saving: boolean
  form: {
    sourcePlanId: string
    capabilityId: string
    status: 'draft' | 'enabled'
    consumptionMultiplier: number
    components: PricingComponent[]
  }
  capabilities: ModelCapability[]
  selectedCapability?: ModelCapability
  meterOptions: PricingMeter[]
  meterLabels: Record<PricingMeter, string>
  membershipOptions: MembershipPricingOption[]
}>()

const emit = defineEmits<{
  close: []
  save: []
  addComponent: []
  removeComponent: [index: number]
  resetMeter: [component: PricingComponent]
}>()

const imageTask = computed(() => props.selectedCapability?.taskType.startsWith('image_'))
const imageMode = computed(() => imageBillingMode(props.form.components))
function changeImageMode(mode: ImageBillingMode, detailed = false) {
  const card = props.form.components[0]?.pricingCardId || ''
  props.form.components = imagePricingComponents(props.selectedCapability, mode, detailed).map(item => ({ ...item, pricingCardId: card }))
}
function imageItemLabel(item: PricingComponent) {
  return item.meter === 'image' ? `${item.dimensions.resolution} · 每张` : `${props.meterLabels[item.meter]}${item.dimensions.modality === 'text' ? '（文字）' : item.dimensions.modality === 'image' ? '（图片）' : ''}`
}
const preview = computed(() => {
  if (!imageTask.value) return ''
  const items = props.form.components
  if (items.some(item => unitPriceOf(item) === null)) return '选择有效套餐后显示积分预估'
  if (imageMode.value !== 'token') return items.map(item => `${imageItemLabel(item)}：${calculatedPoints(item)} 积分`).join('；')
  const budget = props.selectedCapability?.config?.image?.tokenBudget || {input:32768,output:32768}
  const points = (meter: string, modality = '') => {
    const matches = items.filter(item => item.meter === meter && (!item.dimensions.modality || item.dimensions.modality === modality)).sort((a,b)=>Object.keys(b.dimensions).length-Object.keys(a.dimensions).length)
    return matches[0] ? Number(pointsFromSalePrice(matches[0].salePriceCny, unitPriceOf(matches[0])) || 0) : 0
  }
  const estimate = ['text','image'].reduce((sum,modality)=>sum+Math.max(points('input_tokens',modality),points('cached_tokens',modality))*budget.input/1000000,0)+points('output_tokens')*budget.output/1000000
  return `单次预占约 ${formatPoints(estimate)} 积分，成功后按实际用量退差额。上游缺失用量或费用超预占时保留待核对。`
})
function membershipOption(item: PricingComponent) {
  return props.membershipOptions.find(option => option.id === item.pricingCardId)
}
function unitPriceOf(item: PricingComponent) {
  return membershipOption(item)?.unitPriceCny ?? null
}
function calculatedPoints(item: PricingComponent) {
  return formatPoints(pointsFromSalePrice(item.salePriceCny, unitPriceOf(item)))
}
function snapshotChanged(item: PricingComponent) {
  return Boolean(item.membershipSnapshot) && item.membershipSnapshot?.unitPriceCny !== unitPriceOf(item)
}
function optionLabel(option: MembershipPricingOption) {
  return option.usable ? `${option.name} · 1 积分 ${formatUnitPriceCny(option.unitPriceCny)}` : `${option.name} · ${option.reason}`
}

function unitLabel(item: PricingComponent) {
  if (['input_tokens', 'output_tokens', 'cached_tokens'].includes(item.meter)) return '每百万 Token'
  if (item.meter === 'billable_characters') return '每千计费字符'
  if (item.meter === 'audio_seconds') return '每分钟'
  if (item.meter === 'image') return '每张'
  if (item.meter === 'additional_input_images') return '每张额外参考图'
  if (item.meter === 'resource_activation' || item.meter === 'request') return '每次'
  return '每单位'
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-backdrop-v2" @click.self="emit('close')">
      <aside class="form-drawer-v2 pricing-drawer" role="dialog" aria-modal="true" aria-label="配置复合计费方案">
        <header class="drawer-header">
          <div>
            <span class="eyebrow">计费配置</span>
            <h2>{{ form.sourcePlanId ? '编辑计费方案' : imageTask ? '创建图片计费方案' : '创建复合计费方案' }}</h2>
            <p>{{ form.sourcePlanId ? '保存后直接更新当前方案；历史流水仍保留结算时的价格快照。' : '使用业务化选项配置，无需填写技术参数。' }}</p>
          </div>
          <button class="icon-button" aria-label="关闭" @click="emit('close')"><X :size="18" /></button>
        </header>
        <div class="drawer-body">
          <section class="form-section">
            <div class="section-heading"><span>1</span><div><h3>方案信息</h3><p>选择模型能力，并设置客户端展示的消费倍率。</p></div></div>
            <div class="form-grid-v2 plan-grid">
              <label><span>模型任务能力</span><select v-model="form.capabilityId" :title="selectedCapability ? `${selectedCapability.displayName} · ${selectedCapability.taskType}` : ''" :disabled="Boolean(form.sourcePlanId)"><option v-for="item in capabilities" :key="item.id" :value="item.id">{{ item.displayName }} · {{ item.taskType }}</option></select></label>
              <label><span>发布状态</span><select v-model="form.status"><option value="enabled">立即启用</option><option value="draft">保存草稿</option></select></label>
              <label><span>用户消费倍率</span><input v-model.number="form.consumptionMultiplier" type="number" min="0" step="0.01" /><small>可设为 0.00，保留两位小数；仅用于客户端价格感知，不重复参与积分结算。</small></label>
            </div>
          </section>
          <section v-if="imageTask" class="form-section">
            <label><span>图片计费方式</span><select :value="imageMode" @change="changeImageMode(($event.target as HTMLSelectElement).value as ImageBillingMode)"><option value="request">按次 · 成功生成一张扣一次</option><option value="resolution">按分辨率 · 各档位单独定价</option><option value="token" :disabled="selectedCapability?.config?.image?.usage !== 'openai'">按 Token · 实际用量结算</option></select><small>切换方式会重建未保存的价格。参考图不额外按张收费。</small></label>
            <label><span>积分换算套餐</span><select :value="form.components[0]?.pricingCardId || ''" @change="form.components.forEach(item => item.pricingCardId = ($event.target as HTMLSelectElement).value)"><option value="">请选择套餐</option><option v-for="option in membershipOptions" :key="option.id" :value="option.id" :disabled="!option.usable">{{ optionLabel(option) }}</option></select></label>
            <p v-if="!selectedCapability?.config?.image">请先到模型目录保存生成规格，再启用图片计费。</p>
            <p v-else>默认规格：{{ selectedCapability.config.image.defaultSize }}；质量：{{ selectedCapability.config.image.quality || '上游默认' }}。规格范围以模型目录配置为准。</p>
            <details v-if="imageMode === 'token'"><summary>高级：文字、图片和缓存分别定价</summary><p>仅在上游确实返回对应明细时使用；缺少明细会保留任务待核对。</p><button class="secondary-button" @click="changeImageMode('token',true)">展开分项价格</button><button class="text-button" @click="changeImageMode('token')">使用基础输入 / 输出价格</button></details>
            <p role="status">{{ preview }}</p>
          </section>
          <section class="form-section component-editor">
            <div class="section-heading"><span>2</span><div><h3>{{ imageTask ? '成本与售价' : '计费组件' }}</h3><p>计费单位由系统自动设置，成本统一使用人民币。</p></div><button v-if="!imageTask" class="secondary-button compact" @click="emit('addComponent')"><Plus :size="15" />添加</button></div>
            <article v-for="(item,index) in form.components" :key="index" class="component-card">
              <div class="component-title"><strong>{{ imageTask ? imageItemLabel(item) : meterLabels[item.meter] }}</strong><span>{{ unitLabel(item) }}</span><button v-if="!imageTask" class="text-button danger" @click="emit('removeComponent', index)">移除</button></div>
              <div class="form-grid-v2 component-grid">
                <label v-if="!imageTask"><span>计量项</span><select v-model="item.meter" @change="emit('resetMeter', item)"><option v-for="key in meterOptions" :key="key" :value="key">{{ meterLabels[key] }}</option></select></label>
                <label v-if="!imageTask"><span>扣费阶段</span><select v-model="item.phase"><option value="request">请求</option><option value="preview">试听</option><option value="activation">首次启用</option><option value="usage">实际用量</option></select></label>
                <label v-if="!imageTask && item.meter==='image'"><span>图片规格</span><select v-model="item.dimensions.resolution"><option value="1K">1K</option><option value="1.5K">1.5K</option><option value="2K">2K</option></select></label>
                <label v-if="!imageTask"><span>套餐</span><select v-model="item.pricingCardId"><option value="">请选择套餐</option><option v-for="option in membershipOptions" :key="option.id" :value="option.id" :disabled="!option.usable">{{ optionLabel(option) }}</option></select><small v-if="!membershipOptions.some(option => option.usable)">请先在会员卡中设置价格与赠送积分。</small></label>
                <label><span>厂商成本（人民币）</span><input v-model.number="item.costAmount" type="number" min="0" step="0.000001" /></label>
                <label><span>销售价格（人民币）</span><input v-model.number="item.salePriceCny" type="number" min="0" step="0.000001" /><small>按{{ unitLabel(item) }}计费。</small></label>
                <label><span>积分（自动计算）</span><output class="points-output">{{ calculatedPoints(item) }}</output><small v-if="unitPriceOf(item) !== null">积分 = 销售价格 ÷ {{ formatUnitPriceCny(unitPriceOf(item)) }}</small><small v-else>选择有效套餐后自动计算。</small></label>
              </div>

              <div v-if="item.meter==='billable_characters'" class="component-foot">MiniMax：汉字计 2 个字符，其他字符计 1 个；按比例收费，不足千字不取整。试听按上限确认额度，实际少用退回。</div>
              <div v-if="snapshotChanged(item)" class="component-foot component-warning">会员卡单价已变更或原套餐不可用，保存将按当前所选套餐的单价重新计算积分。</div>
              <div class="component-foot">厂商成本与销售价格均为人民币；积分按所选会员卡套餐的积分单价自动计算，用于桌面端扣费。</div>
            </article>
          </section>
        </div>
        <footer class="drawer-footer"><button class="secondary-button" @click="emit('close')">取消</button><button class="primary-button" :disabled="saving || !form.components.length || !membershipOptions.some(option => option.usable)" @click="emit('save')">{{ saving ? '保存中…' : form.sourcePlanId ? '保存修改' : '创建方案' }}</button></footer>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.pricing-drawer{width:min(820px,calc(100vw - 24px))}.drawer-header p{margin:5px 0 0;color:var(--color-text-secondary);font-size:12px}.plan-grid{grid-template-columns:minmax(0,1.35fr) minmax(180px,.65fr)}.plan-grid select{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.component-editor .section-heading{align-items:center}.component-editor .section-heading>div{flex:1}.component-card{border:1px solid var(--color-border-soft);border-radius:16px;padding:16px;margin-top:14px;background:linear-gradient(145deg,var(--color-surface-2),var(--color-surface-1));box-shadow:0 8px 24px rgba(15,23,42,.035)}.component-title{display:grid;grid-template-columns:1fr auto auto;gap:14px;align-items:center;padding-bottom:12px;margin-bottom:14px;border-bottom:1px solid var(--color-border-soft)}.component-title strong{font-size:14px}.component-title>span{color:var(--color-text-secondary);font-size:12px}.component-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.component-grid input,.component-grid select{box-sizing:border-box;width:100%;min-width:0}.points-output{display:flex;align-items:center;min-height:38px;padding:0 12px;border-radius:10px;background:var(--color-surface-3,rgba(148,163,184,.12));font-weight:600}.component-foot{display:flex;justify-content:flex-end;gap:6px;margin-top:12px;color:var(--color-text-secondary);font-size:12px}.component-foot strong{color:var(--color-text-primary)}.component-warning{margin-top:8px;color:var(--color-warning,#b45309)}.compact{padding:7px 10px}@media(max-width:900px){.plan-grid,.component-grid{grid-template-columns:1fr}}
</style>
