import { onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api/user-usage'
import { toUserMessage } from '@/api/client'
import { datePreset } from '@/utils/user-usage'
import type { UsageFilters, UsageOverview, UsagePage, UsageUser, UsageDetail, UsageOptions } from '@/types/user-usage'

export function useUserUsage() {
  const route = useRoute(), auth = useAuthStore()
  const filters = reactive<UsageFilters>({ ...datePreset('month30'), search: '', projectId: '', model: '', type: '', userId: String(route.query.userId || ''), sort: 'points' })
  const applied = ref<UsageFilters>({ ...filters })
  const overview = ref<UsageOverview | null>(null), data = ref<UsagePage<UsageUser>>({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })
  const options = ref<UsageOptions>({ projects: [], models: [] })
  const loading = ref(false), error = ref(''), optionError = ref(''), exporting = ref(false)
  const page = ref(1), pageSize = ref(20)
  const detail = ref<UsageDetail | null>(null), detailId = ref(''), detailLoading = ref(false), detailError = ref('')
  const callPage = ref(1), callPageSize = ref(20)
  let listController: AbortController | null = null, detailController: AbortController | null = null
  async function load() {
    listController?.abort()
    const controller = listController = new AbortController()
    loading.value = true; error.value = ''; data.value.items = []; overview.value = null
    try {
      const result = await Promise.all([api.getUsageOverview(applied.value, controller.signal), api.getUsageUsers(applied.value, page.value, pageSize.value, controller.signal)])
      if (controller.signal.aborted) return
      overview.value = result[0]; data.value = result[1]
    } catch (e) { if (!controller.signal.aborted) error.value = toUserMessage(e) }
    finally { if (listController === controller) loading.value = false }
  }
  async function loadOptions() {
    optionError.value = ''
    try { options.value = await api.getUsageOptions() } catch (e) { optionError.value = `筛选选项加载失败：${toUserMessage(e)}` }
  }
  function closeDetail() { detailController?.abort(); detailId.value = ''; detail.value = null; detailLoading.value = false }
  function apply() { closeDetail(); applied.value = { ...filters }; page.value = 1; void load() }
  function preset(value: string) { Object.assign(filters, datePreset(value)) }
  function reset() { Object.assign(filters, { ...datePreset('month30'), search: '', projectId: '', model: '', type: '', userId: '', sort: 'points' }); apply() }
  function setPage(value: number) { page.value = value; void load() }
  function setPageSize(value: number) { pageSize.value = value; page.value = 1; void load() }
  async function loadDetail() {
    detailController?.abort()
    const controller = detailController = new AbortController()
    const id = detailId.value
    detailLoading.value = true; detailError.value = ''; detail.value = null
    try {
      const value = await api.getUsageDetail(id, applied.value, callPage.value, callPageSize.value, controller.signal)
      if (!controller.signal.aborted) detail.value = value
    } catch (e) { if (!controller.signal.aborted) detailError.value = toUserMessage(e) }
    finally { if (detailController === controller) detailLoading.value = false }
  }
  function openDetail(id: string) { detailId.value = id; callPage.value = 1; void loadDetail() }
  function setCallPage(value: number) { callPage.value = value; void loadDetail() }
  function setCallPageSize(value: number) { callPageSize.value = value; callPage.value = 1; void loadDetail() }
  async function exportCsv() {
    if (!auth.can('user_usage.view') || !auth.can('user_usage.export') || exporting.value) return
    exporting.value = true; error.value = ''
    try { await api.exportUsage(applied.value) } catch (e) { error.value = toUserMessage(e) }
    finally { exporting.value = false }
  }
  onMounted(() => { void load(); void loadOptions(); if (filters.userId) openDetail(filters.userId) })
  watch(() => route.query.userId, value => { filters.userId = String(value || ''); apply(); if (filters.userId) openDetail(filters.userId) })
  onBeforeUnmount(() => { listController?.abort(); detailController?.abort() })
  return { auth, filters, applied, overview, data, options, loading, error, optionError, exporting, page, pageSize,
    detail, detailId, detailLoading, detailError, callPage, callPageSize, load, loadOptions, apply, preset, reset, setPage, setPageSize,
    openDetail, closeDetail, loadDetail, setCallPage, setCallPageSize, exportCsv }
}
