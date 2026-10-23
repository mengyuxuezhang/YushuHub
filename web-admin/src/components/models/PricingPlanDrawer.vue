<script setup lang="ts">
import { Plus, X } from '@lucide/vue'
import type { ModelCapability, PricingComponent, PricingMeter } from '@/types/pricing-center'

defineProps<{
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
}>()

const emit = defineEmits<{
  close: []
  save: []
  addComponent: []
  removeComponent: [index: number]
  resetMeter: [component: PricingComponent]
}>()

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
            <h2>{{ form.sourcePlanId ? '编辑计费方案' : '创建复合计费方案' }}</h2>
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
          <section class="form-section component-editor">
            <div class="section-heading"><span>2</span><div><h3>计费组件</h3><p>计费单位由系统自动设置，成本统一使用人民币。</p></div><button class="secondary-button compact" @click="emit('addComponent')"><Plus :size="15" />添加</button></div>
            <article v-for="(item,index) in form.components" :key="index" class="component-card">
              <div class="component-title"><strong>{{ meterLabels[item.meter] }}</strong><span>{{ unitLabel(item) }}</span><button class="text-button danger" @click="emit('removeComponent', index)">移除</button></div>
              <div class="form-grid-v2 component-grid">
                <label><span>计量项</span><select v-model="item.meter" @change="emit('resetMeter', item)"><option v-for="key in meterOptions" :key="key" :value="key">{{ meterLabels[key] }}</option></select></label>
                <label><span>扣费阶段</span><select v-model="item.phase"><option value="request">请求</option><option value="preview">试听</option><option value="activation">首次启用</option><option value="usage">实际用量</option></select></label>
                <label v-if="item.meter==='image'"><span>图片规格</span><select v-model="item.dimensions.resolution"><option value="1K">1K</option><option value="1.5K">1.5K</option><option value="2K">2K</option></select></label>
                <label><span>厂商成本（人民币）</span><input v-model.number="item.costAmount" type="number" min="0" step="0.000001" /></label>
                <label><span>用户售价（积分）</span><input v-model.number="item.salePoints" type="number" min="0" step="0.000001" /></label>
              </div>
              <div v-if="item.meter==='additional_input_images'" class="component-foot">每次请求首张参考图免费，从第二张起按实际张数收费。</div>
              <div v-if="item.meter==='billable_characters'" class="component-foot">MiniMax：汉字计 2 个字符，其他字符计 1 个；按比例收费，不足千字不取整。试听按上限确认额度，实际少用退回。</div>
              <div class="component-foot">成本为人民币，售价为积分；实际毛利需按会员卡的积分兑换比例计算。</div>
            </article>
          </section>
        </div>
        <footer class="drawer-footer"><button class="secondary-button" @click="emit('close')">取消</button><button class="primary-button" :disabled="saving || !form.components.length" @click="emit('save')">{{ saving ? '保存中…' : form.sourcePlanId ? '保存修改' : '创建方案' }}</button></footer>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.pricing-drawer{width:min(820px,calc(100vw - 24px))}.drawer-header p{margin:5px 0 0;color:var(--color-text-secondary);font-size:12px}.plan-grid{grid-template-columns:minmax(0,1.35fr) minmax(180px,.65fr)}.plan-grid select{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.component-editor .section-heading{align-items:center}.component-editor .section-heading>div{flex:1}.component-card{border:1px solid var(--color-border-soft);border-radius:16px;padding:16px;margin-top:14px;background:linear-gradient(145deg,var(--color-surface-2),var(--color-surface-1));box-shadow:0 8px 24px rgba(15,23,42,.035)}.component-title{display:grid;grid-template-columns:1fr auto auto;gap:14px;align-items:center;padding-bottom:12px;margin-bottom:14px;border-bottom:1px solid var(--color-border-soft)}.component-title strong{font-size:14px}.component-title>span{color:var(--color-text-secondary);font-size:12px}.component-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.component-grid input,.component-grid select{box-sizing:border-box;width:100%;min-width:0}.component-foot{display:flex;justify-content:flex-end;gap:6px;margin-top:12px;color:var(--color-text-secondary);font-size:12px}.component-foot strong{color:var(--color-text-primary)}.compact{padding:7px 10px}@media(max-width:900px){.plan-grid,.component-grid{grid-template-columns:1fr}}
</style>
