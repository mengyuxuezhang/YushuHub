import { onMounted, onUnmounted, ref } from 'vue'
import { getSelfUpdateStatus } from '@/api/delivery-system'
import { useAuthStore } from '@/stores/auth'

export function useAdminUpdateNotice() {
  const auth = useAuthStore()
  const status = ref<any | null>(null)
  let timer: number | undefined

  async function refresh() {
    if (!auth.can('self_update.manage')) return
    status.value = await getSelfUpdateStatus().catch(() => status.value)
  }

  onMounted(() => {
    refresh()
    if (auth.can('self_update.manage')) timer = window.setInterval(refresh, 5 * 60_000)
  })
  onUnmounted(() => { if (timer) window.clearInterval(timer) })

  return { status, refresh }
}
