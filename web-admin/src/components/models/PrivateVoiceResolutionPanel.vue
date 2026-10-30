<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { reconcileSupplyPrivateVoice } from '@/api/supply'
import type { SupplyUsage, VoiceResolutionInput } from '@/api/supply'
const props = defineProps<{ item: SupplyUsage }>()
const emit = defineEmits<{ done: []; cancel: [] }>()
const commandId = crypto.randomUUID(), busy = ref(false), error = ref(''), submitted = ref<VoiceResolutionInput | null>(null)
const form = reactive({ providerFinal: false, evidence: '', resultState: 'failed' as 'succeeded' | 'failed', accepted: true, characters: '', activated: false })
const action = computed(() => props.item.reconcileAction || 'synthesize')
const phase = computed(() => action.value === 'clone' ? 'preview' : action.value === 'activate' ? 'activation' : 'usage')
const valid = computed(() => form.providerFinal && form.evidence.trim().length >= 5 && (!form.accepted || /^(?:0|[1-9]\d{0,8})$/.test(form.characters.trim())) && (form.resultState !== 'succeeded' || (form.accepted && action.value === 'clone')))
async function submit() {
  if (busy.value || (!submitted.value && !valid.value)) return
  if (!submitted.value) {
    const usage: VoiceResolutionInput['usage'] = form.accepted ? [{ meter: 'request', phase: 'request', quantity: '1' }, { meter: 'billable_characters', phase: phase.value, quantity: form.characters.trim() }] : []
    if (form.accepted && action.value === 'activate' && form.activated) usage.push({ meter: 'resource_activation', phase: 'activation', quantity: '1' })
    submitted.value = { commandId, providerFinal: true, evidence: form.evidence.trim(), resultState: form.resultState, usage }
  }
  busy.value = true; error.value = ''
  try { await reconcileSupplyPrivateVoice(props.item.requestId, submitted.value); emit('done') }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '核对状态尚未明确，请按原编号重试' }
  finally { busy.value = false }
}
</script>
<template>
  <form class="panel-card" @submit.prevent="submit">
    <h2>核对自接私有音色</h2>
    <p>原调用 {{ item.requestId }}。按原价格快照结算已确认的实际用量；失败结果也可能保留已发生的费用。此入口仅处理本组织调用。</p>
    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <fieldset :disabled="busy || !!submitted">
      <label>最终结果<select v-model="form.resultState"><option value="failed">费用已核对，原结果失败或音频不可取回</option><option v-if="action === 'clone'" value="succeeded">原试听和音色可核验，确认成功</option></select></label>
      <label><input v-model="form.accepted" type="checkbox" />供应商确认已受理计费请求</label>
      <label v-if="form.accepted">实际计费字符<input v-model="form.characters" type="text" inputmode="numeric" pattern="0|[1-9][0-9]{0,8}" required /></label>
      <label v-if="form.accepted && action === 'activate'"><input v-model="form.activated" type="checkbox" />确认首次启用费用已发生</label>
      <label>核对凭证<input v-model="form.evidence" minlength="5" maxlength="1000" required placeholder="供应商最终账单、工单或核对凭证" /></label>
      <label><input v-model="form.providerFinal" type="checkbox" required />已确认供应商结果最终完成，以上实际用量准确</label>
    </fieldset>
    <p v-if="submitted">核对编号 {{ commandId }}。状态未明确时请保留此表单，按原编号重试。</p>
    <button class="primary-button" :disabled="busy || (!submitted && !valid)">{{ submitted ? '按原编号重试' : '确认核对并结算' }}</button>
    <button type="button" class="secondary-button" :disabled="busy" @click="emit('cancel')">关闭</button>
  </form>
</template>
