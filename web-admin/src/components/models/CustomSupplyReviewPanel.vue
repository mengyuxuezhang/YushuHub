<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { customSupplyReview, saveCustomSupplyDefinition } from '@/api/supply'
import type { CustomSupplyReview, CustomSupplyCandidate, SupplyComponent } from '@/api/supply'
const emit = defineEmits<{ saved: [] }>()
const state = ref<CustomSupplyReview | null>(null), selected = ref(''), busy = ref(false), error = ref(''), message = ref('')
const form = reactive({ adapter: '', clientId: '', enabled: true, contextWindow: 0, maxOutputTokens: 0, maxImages: 1, supportsStreaming: false, memo: '', allowedVoiceIds: [] as string[] })
const costs = ref<SupplyComponent[]>([])
const record = computed(() => state.value?.records.find(row => row.definition.id === selected.value))
const candidate = computed(() => state.value?.candidates.find(row => row.id === selected.value))
const labels: Record<string, string> = { request: '每次请求', input_tokens: '输入Token', cached_tokens: '缓存命中Token', output_tokens: '输出Token', image: '图片', billable_characters: '计费字符' }
async function perform(work: () => Promise<unknown>) { busy.value = true; error.value = ''; try { await work() } catch (e) { error.value = e instanceof Error ? e.message : '审核操作失败' } finally { busy.value = false } }
async function load() { state.value = await customSupplyReview() }
async function refresh() { selected.value = ''; await load() }
function edit(item: CustomSupplyCandidate | { id: string }) {
  selected.value = item.id; message.value = ''
  const definition = record.value?.definition, source = candidate.value
  Object.assign(form, { adapter: definition?.adapter || source?.adapters[0] || '', clientId: definition?.clientId || source?.clientId || item.id,
    enabled: definition?.status !== 'disabled', contextWindow: definition?.contextWindow || source?.contextWindow || 0,
    maxOutputTokens: definition?.maxOutputTokens || Math.min(4096, source?.contextWindow || 0), maxImages: definition?.maxImages || 1,
    supportsStreaming: definition?.supportsStreaming === true, allowedVoiceIds: [...(definition?.allowedVoiceIds || [])], memo: '' })
  costs.value = (definition?.supplierCost.components || source?.costComponents || []).map(component => ({ ...component, dimensions: component.dimensions ? { ...component.dimensions } : undefined }))
}
async function save() {
  await perform(async () => {
    await saveCustomSupplyDefinition({ providerModelId: selected.value, expectedRevision: record.value?.revision || 0, ...form,
      status: form.enabled ? 'enabled' : 'disabled', currency: 'CNY', costComponents: costs.value })
    selected.value = ''; await load(); emit('saved'); message.value = '供货定义已审核。实际用户售价和二级供货价请在下方分级定价中设置；新模型还需启用供货。'
  })
}
onMounted(() => perform(load))
</script>
<template>
  <article class="panel-card custom-review">
    <h2>自接模型供货审核</h2>
    <button type="button" class="secondary-button" :disabled="busy" @click="perform(refresh)">刷新审核状态</button>
    <p>沿用已有供应商与Key池。核定人民币成本、计量单位和调用上限后，再设置用户售价与二级供货价。旧积分价格不自动当作供应商成本。</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <template v-if="state">
      <div class="table-scroll"><table><thead><tr><th>本地模型</th><th>审核状态</th><th>操作</th></tr></thead><tbody>
        <tr v-for="item in state.candidates" :key="item.id"><td>{{ item.name }}<small>{{ item.id }} · {{ item.providerId }}</small></td><td>{{ state.fileModelIds.includes(item.id) ? '受控文件管理' : state.records.find(row => row.definition.id === item.id)?.definition.status === 'enabled' ? '已审核启用' : state.records.some(row => row.definition.id === item.id) ? '已停用' : '未审核' }}</td><td><button type="button" class="secondary-button" :disabled="busy || state.fileModelIds.includes(item.id)" @click="edit(item)">审核成本与上限</button></td></tr>
        <tr v-for="row in state.records.filter(row => !state!.candidates.some(item => item.id === row.definition.id))" :key="row.definition.id"><td>{{ row.definition.id }}<small>本地模型已停用或归档</small></td><td>版本 {{ row.revision }}</td><td><button type="button" class="secondary-button" :disabled="busy" @click="edit({ id: row.definition.id })">查看与停用</button></td></tr>
      </tbody></table></div>
      <p v-if="!state.candidates.length && !state.records.length">请先在供应商、模型与Key池中建立本组织配置。</p>
    </template>
    <form v-if="selected" @submit.prevent="save">
      <h3>{{ candidate?.name || selected }} · 审核版本 {{ record?.revision || 0 }}</h3>
      <label>调用方式<select v-model="form.adapter" :disabled="!!record"><option v-for="adapter in candidate?.adapters || [form.adapter]" :key="adapter" :value="adapter">{{ adapter === 'minimax.speech_async' ? 'MiniMax异步语音' : adapter === 'minimax.speech' ? 'MiniMax同步语音' : adapter === 'openai.chat' ? '兼容文本' : adapter === 'openai.images' ? '兼容图片' : '博查搜索' }}</option></select></label>
      <label>客户端模型标识<input v-model="form.clientId" required maxlength="160" /><small>默认沿用原模型标识；同目录内须唯一。</small></label>
      <label><input v-model="form.enabled" type="checkbox" />启用此供货定义</label>
      <template v-if="form.adapter === 'openai.chat'">
        <label>上下文上限<input v-model.number="form.contextWindow" type="number" min="1" :max="candidate?.contextWindow || 10000000" required /></label>
        <label>输出上限<input v-model.number="form.maxOutputTokens" type="number" min="1" :max="form.contextWindow" required /></label>
        <label><input v-model="form.supportsStreaming" type="checkbox" />允许纯文本流式输出</label>
      </template>
      <label v-if="form.adapter === 'openai.images'">单次图片上限<input v-model.number="form.maxImages" type="number" min="1" max="10" required /></label>
      <fieldset v-if="form.adapter.startsWith('minimax.')"><legend>批准的公共音色</legend><label v-for="voice in candidate?.voices || []" :key="voice.id"><input v-model="form.allowedVoiceIds" type="checkbox" :value="voice.id" />{{ voice.name }}<small>{{ voice.id }}</small></label><p v-if="!candidate?.voices.length">尚无已登记的启用公共音色，请先同步公共音色目录。</p></fieldset>
      <h3>供应商成本（人民币）</h3><p>全部计量项都须明确填写，免费项填0。已审核的计量单位与结构固定；后续成本变化保留原任务快照。</p>
      <div class="cost-grid"><label v-for="(item, index) in costs" :key="index">{{ labels[item.meter] || item.meter }} {{ item.dimensions?.resolution || '' }}<span>每 <input v-model="item.unitSize" type="text" inputmode="decimal" :readonly="!!record" required /> 单位</span><span>¥ <input v-model="item.amount" type="text" inputmode="decimal" required /></span></label></div>
      <label>核定依据<input v-model="form.memo" minlength="3" maxlength="500" required placeholder="报价或账单依据及核定说明" /></label>
      <button class="primary-button" :disabled="busy">确认审核并保存</button><button type="button" class="secondary-button" :disabled="busy" @click="selected = ''">取消</button>
    </form>
  </article>
</template>
<style scoped>
.custom-review{padding:24px;margin:18px 0}.custom-review label{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.custom-review input,.custom-review select{padding:8px;max-width:320px}.custom-review small{display:block}.custom-review table{width:100%;text-align:left;border-collapse:collapse}.custom-review td,.custom-review th{padding:10px;border-bottom:1px solid #e2e8f0}.table-scroll{overflow:auto}.cost-grid input{max-width:120px}.cost-grid label{padding:8px;border-bottom:1px solid #e2e8f0}.custom-review form{margin-top:20px}
</style>
