import { computed, onMounted, reactive, ref } from 'vue'

import * as api from '@/api/organization'
import { toUserMessage } from '@/api/client'
import { useFeedbackStore } from '@/stores/feedback'
import type { CenterSupplier } from '@/types/organization'
import { formatLicenseExpiry, localExpiryInput } from '@/utils/supplier-license'

const emptyForm = () => ({
  id: '', name: '', notes: '', status: 'enabled' as const, licenseType: 'partner' as const,
  maxProjects: 0, maxBuilds: 0, allowAgentManagement: true,
  allowSupplierManagement: false, allowPlatformSettings: true,
  allowCustomBrand: true, allowCustomApiProviders: false,
  tokenPreview: '', deploymentConfig: '',
  neverExpires: true, expiresAt: '',
})

export function useCenterSuppliers() {
  const feedback = useFeedbackStore()
  const suppliers = ref<CenterSupplier[]>([])
  const loading = ref(false), saving = ref(false), drawerOpen = ref(false)
  const search = ref(''), searchField = ref('all'), appliedSearch = ref(''), appliedSearchField = ref('all'), status = ref('all')
  const errorMessage = ref(''), revealNotice = ref('')
  const form = reactive<Record<string, any>>(emptyForm())
  const rows = computed(() => {
    const query = appliedSearch.value.toLowerCase()
    return suppliers.value.filter((supplier) => {
      if (status.value !== 'all' && (supplier.authorizationStatus || supplier.status) !== status.value) return false
      const candidates = appliedSearchField.value === 'name' ? [supplier.name]
        : appliedSearchField.value === 'id' ? [supplier.id]
          : appliedSearchField.value === 'notes' ? [supplier.notes]
            : [supplier.name, supplier.id, supplier.notes]
      return !query || candidates.some((value) => String(value || '').toLowerCase().includes(query))
    })
  })
  const searchFields = [
    { value: 'all', label: '全部字段' },
    { value: 'name', label: '代理名称' },
    { value: 'id', label: 'Supplier ID' },
    { value: 'notes', label: '备注' },
  ]

  async function load() {
    loading.value = true
    try { suppliers.value = await api.listCenterSuppliers() }
    catch (error) { feedback.notify(toUserMessage(error), 'error') }
    finally { loading.value = false }
  }
  function submitSearch() { appliedSearch.value = search.value.trim(); appliedSearchField.value = searchField.value }
  function resetSearch() { search.value = ''; searchField.value = 'all'; appliedSearch.value = ''; appliedSearchField.value = 'all'; status.value = 'all' }
  function openCreate() { Object.assign(form, emptyForm()); errorMessage.value = ''; revealNotice.value = ''; drawerOpen.value = true }
  function setForm(supplier: CenterSupplier) {
    Object.assign(form, emptyForm(), supplier, { neverExpires: !supplier.expiresAt, expiresAt: localExpiryInput(supplier.expiresAt) })
  }
  function openEdit(supplier: CenterSupplier) { setForm(supplier); form.deploymentConfig = ''; errorMessage.value = ''; revealNotice.value = ''; drawerOpen.value = true }
  async function save() {
    if (saving.value) return
    if (!String(form.name || '').trim()) { errorMessage.value = '请填写一级代理名称'; return }
    if (!form.neverExpires && (!form.expiresAt || !Number.isFinite(new Date(form.expiresAt).getTime()))) { errorMessage.value = '请选择有效的授权到期时间'; return }
    saving.value = true; errorMessage.value = ''
    try {
      const saved = await api.saveCenterSupplier({ ...form, expiresAt: form.neverExpires ? null : new Date(form.expiresAt).toISOString(), maxProjects: Number(form.maxProjects || 0), maxBuilds: Number(form.maxBuilds || 0) })
      const index = suppliers.value.findIndex((item) => item.id === saved.id)
      if (index >= 0) suppliers.value.splice(index, 1, saved); else suppliers.value.unshift(saved)
      setForm(saved)
      revealNotice.value = saved.token ? '新 Token 仅在本次显示，请立即复制并妥善保存。' : '一级代理授权已保存。'
      feedback.notify(saved.token ? '一级代理已创建，请立即复制部署配置' : '一级代理授权已保存', 'success')
    } catch (error) { errorMessage.value = toUserMessage(error) }
    finally { saving.value = false }
  }
  async function resetToken(supplier: CenterSupplier) {
    const confirmed = await feedback.confirm({ title: `重置“${supplier.name}”的 Token？`, message: '旧 Token 会立即失效，下游管理后台必须更新 .env 后才能继续连接。', confirmText: '重置 Token', tone: 'danger' })
    if (!confirmed || saving.value) return
    saving.value = true
    try {
      const saved = await api.resetCenterSupplierToken(supplier.id)
      const index = suppliers.value.findIndex((item) => item.id === saved.id)
      if (index >= 0) suppliers.value.splice(index, 1, saved)
      setForm(saved)
      errorMessage.value = ''; revealNotice.value = 'Token 已重置，新 Token 仅在本次显示，请立即复制并更新下游 .env。'; drawerOpen.value = true
      feedback.notify('Token 已重置，请立即复制部署配置', 'success')
    } catch (error) { feedback.notify(toUserMessage(error), 'error') }
    finally { saving.value = false }
  }
  async function remove(supplier: CenterSupplier) {
    const confirmed = await feedback.confirm({ title: `删除“${supplier.name}”？`, message: '删除后 Supplier Token 会立即失效，接入授权不可恢复；历史业务与构建记录仍会保留。', confirmText: '删除供应商', tone: 'danger' })
    if (!confirmed || saving.value) return
    saving.value = true
    try {
      await api.deleteCenterSupplier(supplier.id)
      suppliers.value = suppliers.value.filter((item) => item.id !== supplier.id)
      if (form.id === supplier.id) drawerOpen.value = false
      feedback.notify('供应商接入授权已删除', 'success')
    } catch (error) { feedback.notify(toUserMessage(error), 'error') }
    finally { saving.value = false }
  }
  async function copyConfig() {
    const value = String(form.deploymentConfig || '')
    if (!value) { feedback.notify('当前没有可复制的新部署配置，请重置 Token 后再试', 'warning'); return }
    try { await navigator.clipboard.writeText(value); feedback.notify('部署配置已复制', 'success') }
    catch { feedback.notify('复制失败，请手动选择文本复制', 'error') }
  }
  function formatTime(value?: string) { return value ? new Date(value).toLocaleString('zh-CN') : '暂无' }
  onMounted(load)
  return { suppliers, rows, loading, saving, drawerOpen, search, searchField, status, searchFields, errorMessage, revealNotice, form, load, submitSearch, resetSearch, openCreate, openEdit, save, resetToken, remove, copyConfig, formatTime, formatLicenseExpiry }
}
