<script setup lang="ts">
import { computed, ref } from 'vue'
import { resolvePaymentRefund } from '@/api/payment-refunds'
import type { PaymentRefundResolution, PaymentRefundResult } from '@/api/payment-refunds'
import { toUserMessage } from '@/api/client'
const props = defineProps<{ result: PaymentRefundResult }>()
const emit = defineEmits<{ updated: [] }>()
const evidence = ref(''), providerFinal = ref(false), resultState = ref<'succeeded' | 'closed'>('closed'), busy = ref(false), error = ref('')
const resolutionId = crypto.randomUUID(), submitted = ref<PaymentRefundResolution | null>(null)
const valid = computed(() => providerFinal.value && evidence.value.trim().length >= 5 && evidence.value.length <= 1000 && (!props.result.unsubmitted || resultState.value === 'closed'))
async function submit() {
  if (busy.value || (!submitted.value && (!props.result.canResolve || !valid.value))) return
  if (!submitted.value) submitted.value = { resolutionId, refundNo: props.result.refundNo, resultState: resultState.value, providerFinal: true, evidence: evidence.value.trim() }
  busy.value = true; error.value = ''
  try { await resolvePaymentRefund(props.result.orderId, submitted.value); emit('updated') }
  catch (failure) { error.value = toUserMessage(failure) }
  finally { busy.value = false }
}
</script>
<template>
  <form aria-label="现金退款最终核对" @submit.prevent="submit">
    <h3>经营方最终核对</h3>
    <p>只登记已核对的原退款 {{ result.refundNo }} 结果，不再向平台发起退款。</p>
    <p v-if="result.unsubmitted">此申请明确尚未提交，只能取消并返还暂扣权益。</p>
    <p v-else>须先通过原商户最终账单或工单确认结果。平台仍在处理、只有查无记录或没有最终凭证时，请继续等待核对。</p>
    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <fieldset :disabled="busy || !!submitted">
      <label>最终结果<select v-model="resultState"><option value="closed">确认已关闭或明确未提交，返还暂扣</option><option v-if="!result.unsubmitted" value="succeeded">确认原全额退款已成功，完成权益撤回</option></select></label>
      <label>最终核对凭证<textarea v-model="evidence" minlength="5" maxlength="1000" required placeholder="原商户最终账单、工单编号及核对结论" /></label>
      <label><input v-model="providerFinal" type="checkbox" required />已确认原编号的最终结果，以上凭证和结论准确</label>
    </fieldset>
    <p v-if="submitted">核对编号 {{ resolutionId }}，回复丢失时请按原编号重试或查询原退款。</p>
    <button class="secondary-button" :disabled="busy || (!submitted && !valid)">{{ submitted ? '按原核对指令重试' : '登记核对结果并处理原权益' }}</button>
  </form>
</template>
