<script setup lang="ts">
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from '@lucide/vue'
import { useFeedbackStore } from '@/stores/feedback'

const feedback = useFeedbackStore()
const icons = { success: CheckCircle2, error: XCircle, warning: AlertTriangle, info: Info }
</script>

<template>
  <div class="toast-region" aria-live="polite" aria-atomic="true">
    <div v-for="toast in feedback.toasts" :key="toast.id" class="toast-item" :class="`is-${toast.tone}`" role="status">
      <component :is="icons[toast.tone]" :size="19" />
      <span>{{ toast.message }}</span>
      <button type="button" aria-label="关闭提示" @click="feedback.dismiss(toast.id)"><X :size="16" /></button>
    </div>
  </div>

  <div v-if="feedback.confirmOptions" class="dialog-backdrop" role="presentation" @click.self="feedback.resolveConfirm(false)">
    <section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
      <span class="dialog-icon" :class="{ 'is-danger': feedback.confirmOptions.tone === 'danger' }"><AlertTriangle :size="22" /></span>
      <h2 id="confirm-title">{{ feedback.confirmOptions.title }}</h2>
      <p id="confirm-message">{{ feedback.confirmOptions.message }}</p>
      <div class="dialog-actions">
        <button type="button" class="secondary-button" @click="feedback.resolveConfirm(false)">取消</button>
        <button type="button" class="primary-button" :class="{ 'danger-button': feedback.confirmOptions.tone === 'danger' }" @click="feedback.resolveConfirm(true)">{{ feedback.confirmOptions.confirmText || '确认' }}</button>
      </div>
    </section>
  </div>
</template>
