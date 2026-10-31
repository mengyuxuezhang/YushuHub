import { computed, onScopeDispose, ref, watch } from 'vue'
import { querySupportedUsers, setSupportedUserStatus, type SupportedEndUser, type SupportCommand } from '@/api/organization-support'
import { ApiError, toUserMessage } from '@/api/client'
import { useFeedbackStore } from '@/stores/feedback'

export function useOrganizationSupport(target: () => { id: string; name: string } | null) {
  const feedback = useFeedbackStore(), reason = ref(''), search = ref(''), items = ref<SupportedEndUser[]>([]), total = ref(0), page = ref(1)
  const loading = ref(false), saving = ref(false), error = ref(''), hasLoaded = ref(false)
  const pending = ref<{ organizationId: string; user: SupportedEndUser; command: SupportCommand } | null>(null)
  const canQuery = computed(() => reason.value.trim().length >= 8 && reason.value.trim().length <= 500 && !loading.value && !saving.value && !pending.value)
  let generation = 0
  function denied(e: unknown) { if (e instanceof ApiError && [401, 403].includes(e.status)) { items.value = []; total.value = 0; hasLoaded.value = false; pending.value = null } }
  function reset() { generation++; reason.value = ''; search.value = ''; items.value = []; total.value = 0; page.value = 1; error.value = ''; loading.value = false; saving.value = false; pending.value = null; hasLoaded.value = false }
  watch(() => target()?.id, reset, { immediate: true }); onScopeDispose(() => { generation++ })
  async function load(nextPage = 1) {
    const selected = target(); if (!selected || !canQuery.value) return
    const current = ++generation; loading.value = true; error.value = ''
    try {
      const result = await querySupportedUsers(selected.id, { reason: reason.value.trim(), search: search.value.trim(), page: nextPage, pageSize: 20 })
      if (current !== generation) return
      items.value = result.items; total.value = result.total; page.value = result.page; hasLoaded.value = true
    } catch (e) { if (current === generation) { denied(e); error.value = toUserMessage(e) } } finally { if (current === generation) loading.value = false }
  }
  function prepare(user: SupportedEndUser) {
    const selected = target(); if (!selected || !canQuery.value) return
    pending.value = { organizationId: selected.id, user: { ...user }, command: { commandId: crypto.randomUUID(), reason: reason.value.trim(),
      expectedStatus: user.status, status: user.status === 'enabled' ? 'disabled' : 'enabled' } }; error.value = ''
  }
  async function confirm() {
    const request = pending.value; if (!request || saving.value || target()?.id !== request.organizationId) return
    const current = generation; saving.value = true; error.value = ''
    try {
      const result = await setSupportedUserStatus(request.organizationId, request.user.id, request.command)
      if (current !== generation) return
      const user = items.value.find(item => item.id === request.user.id); if (user) user.status = result.currentStatus
      pending.value = null; feedback.notify('终端状态已更新，操作已记录到目标组织审计', 'success')
    } catch (e) { if (current === generation) { denied(e); error.value = toUserMessage(e) } } finally { if (current === generation) saving.value = false }
  }
  return { reason, search, items, total, page, loading, saving, error, hasLoaded, pending, canQuery, load, prepare, confirm }
}
