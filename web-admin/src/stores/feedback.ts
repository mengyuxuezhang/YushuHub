import { ref } from 'vue'
import { defineStore } from 'pinia'

export type ToastTone = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: number
  message: string
  tone: ToastTone
}

export interface ConfirmOptions {
  title: string
  message: string
  confirmText?: string
  tone?: 'primary' | 'danger'
}

export const useFeedbackStore = defineStore('feedback', () => {
  const toasts = ref<ToastItem[]>([])
  const confirmOptions = ref<ConfirmOptions | null>(null)
  let nextId = 1
  let confirmResolver: ((value: boolean) => void) | null = null

  function notify(message: string, tone: ToastTone = 'info', duration = 3600) {
    const id = nextId++
    toasts.value.push({ id, message, tone })
    window.setTimeout(() => dismiss(id), duration)
    return id
  }

  function dismiss(id: number) {
    toasts.value = toasts.value.filter((item) => item.id !== id)
  }

  function confirm(options: ConfirmOptions) {
    if (confirmResolver) confirmResolver(false)
    confirmOptions.value = options
    return new Promise<boolean>((resolve) => { confirmResolver = resolve })
  }

  function resolveConfirm(result: boolean) {
    confirmResolver?.(result)
    confirmResolver = null
    confirmOptions.value = null
  }

  return { toasts, confirmOptions, notify, dismiss, confirm, resolveConfirm }
})
