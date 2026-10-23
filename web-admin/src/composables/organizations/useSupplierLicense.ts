import { onMounted, onUnmounted, ref } from 'vue'
import { getSupplierLicense } from '@/api/organization'
import { toUserMessage } from '@/api/client'
import type { SupplierLicense } from '@/types/organization'
import { useAuthStore } from '@/stores/auth'

export function useSupplierLicense() {
  const auth = useAuthStore()
  const license = ref<SupplierLicense | null>(null)
  const loading = ref(false), error = ref(''), now = ref(Date.now())
  let timer: number | undefined
  async function refresh(force = false) {
    now.value = Date.now()
    if (loading.value) return
    loading.value = true
    try {
      const previous = license.value?.status
      license.value = await getSupplierLicense(force); error.value = ''
      if (previous && previous !== license.value.status) await auth.initialize(true).catch(() => {})
    }
    catch (failure) { error.value = toUserMessage(failure) }
    finally { loading.value = false; now.value = Date.now() }
  }
  function resume() { if (!document.hidden) void refresh() }
  onMounted(() => {
    void refresh()
    timer = window.setInterval(() => { now.value = Date.now(); if (!document.hidden) void refresh() }, 60_000)
    document.addEventListener('visibilitychange', resume)
  })
  onUnmounted(() => {
    if (timer) window.clearInterval(timer)
    document.removeEventListener('visibilitychange', resume)
  })
  return { license, loading, error, now, refresh }
}
