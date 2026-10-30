<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getPaymentRefund, previewPaymentRefund, queryPaymentRefund, requestPaymentRefund } from '@/api/payment-refunds'
import type { PaymentRefundCommand, PaymentRefundPreview, PaymentRefundResult } from '@/api/payment-refunds'
import { ApiError, toUserMessage } from '@/api/client'
const props = withDefaults(defineProps<{ order: { id: string; orderNo?: string }; allowNew?: boolean }>(), { allowNew: true })
const emit = defineEmits<{ close: []; updated: [] }>()
const busy = ref(false), error = ref(''), preview = ref<PaymentRefundPreview | null>(null), result = ref<PaymentRefundResult | null>(null)
const reason = ref(''), confirmed = ref(false), submitted = ref<PaymentRefundCommand | null>(null), commandId = crypto.randomUUID()
const labels: Record<string, string> = { prepared: '已受理，等待提交原退款', submitted: '原退款已提交', processing: '平台处理中', unknown: '结果待核对', succeeded: '退款成功', closed: '原退款已关闭，权益暂扣已返还' }
const valid = computed(() => preview.value && confirmed.value && reason.value.trim().length > 0 && [...reason.value].length <= 80)
const money = (fen: number) => Number.isSafeInteger(fen) ? `${BigInt(fen) / 100n}.${String(BigInt(fen) % 100n).padStart(2, '0')}` : '—'
async function status(query = false) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { result.value = await (query ? queryPaymentRefund(props.order.id) : getPaymentRefund(props.order.id)); if (result.value) emit('updated') }
  catch (failure) { error.value = toUserMessage(failure) }
  finally { busy.value = false }
}
async function review() {
  if (busy.value || submitted.value || !props.allowNew) return
  busy.value = true; error.value = ''
  try { preview.value = await previewPaymentRefund(props.order.id) }
  catch (failure) { error.value = toUserMessage(failure) }
  finally { busy.value = false }
}
async function submit() {
  if (busy.value || !props.allowNew || (!submitted.value && !valid.value)) return
  if (!submitted.value) submitted.value = { commandId, reason: reason.value.trim(), previewDigest: preview.value!.previewDigest, confirmEntitlements: true }
  busy.value = true; error.value = ''
  try { result.value = await requestPaymentRefund(props.order.id, submitted.value); emit('updated') }
  catch (failure) {
    error.value = toUserMessage(failure)
    if (failure instanceof ApiError && (failure.details as { code?: string } | undefined)?.code === 'PAYMENT_REFUND_PREVIEW_CHANGED') {
      submitted.value = null; preview.value = null; confirmed.value = false
    }
  }
  finally { busy.value = false }
}
onMounted(() => status())
</script>

<template>
  <section class="panel-card" aria-label="原订单现金售后">
    <h2>原订单现金售后</h2>
    <p>订单 {{ order.orderNo || order.id }}。现金按原收款账号原路退回；仅处理本组织订单。</p>
    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <template v-if="result">
      <p role="status">{{ labels[result.state] || '结果待核对' }} · ¥{{ money(result.amountFen) }}</p>
      <p>原退款编号：{{ result.refundNo }}</p>
      <p>原因：{{ result.reason }}；关联积分：{{ result.points }}</p>
      <p v-if="!['succeeded','closed'].includes(result.state)">暂扣权益继续保留，登录和免费权益可用。查询未确认或平台查无记录都不会自动撤销本次退款；请保留原编号核对。</p>
      <p v-if="result.errorCode === 'PAYMENT_MERCHANT_CHANGED'">原收款配置已变化，请恢复原账号后再查询，不能换号处理。</p>
    </template>
    <template v-else>
      <p v-if="!allowNew">当前停止受理新的现金退款，已受理的原退款仍可查询和恢复。</p>
      <button v-if="!preview && allowNew" class="secondary-button" :disabled="busy || !!submitted" @click="review">预览原路退款与权益撤回</button>
      <form v-if="preview && allowNew" @submit.prevent="submit">
        <p>退款 ¥{{ money(preview.amountFen) }}；撤回原发放积分 {{ preview.pointsToWithdraw }}，余额从 {{ preview.balanceBefore }} 变为 {{ preview.balanceAfter }}。</p>
        <p>冻结购买会员：{{ preview.cancelMembership.name }}。退款成功后{{ preview.restoreMembership ? `按原日期恢复 ${preview.restoreMembership.name}（${preview.restoreMembership.expiresAt || '原永久有效期'}）` : '保留免费会员' }}。</p>
        <p>平台结果未确认期间提供免费权益，不重新发赠送积分；原模型消费及上游供货费用不会因现金退款而返还。</p>
        <fieldset :disabled="busy || !!submitted">
          <label>退款原因<input v-model="reason" maxlength="80" required /></label>
          <label><input v-model="confirmed" type="checkbox" required />已核对原订单及上述权益撤回，确认单笔全额原路退款</label>
        </fieldset>
        <button class="primary-button" :disabled="busy || (!submitted && !valid)">{{ submitted ? '按原指令重试' : '确认退款并暂扣权益' }}</button>
      </form>
      <p v-if="submitted">指令 {{ commandId }}。回复丢失时请查询原退款或按原指令重试，不要另行打款。</p>
    </template>
    <button class="secondary-button" :disabled="busy" @click="status(true)">查询原退款</button>
    <button class="secondary-button" :disabled="busy" @click="emit('close')">关闭面板</button>
  </section>
</template>
