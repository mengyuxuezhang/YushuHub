import { computed, onMounted, reactive, ref, watch, type Ref } from 'vue'

import { createCatalogResource, createMcpVersion, deleteCatalogResource, getCatalogResource, getCatalogSyncStatus, listCatalogDistributions, listCatalogResources, publishCatalogVersion, saveCatalogDistribution, startCatalogSync, updateCatalogResource, updateCatalogResourceStatus, uploadSkillVersion } from '@/api/catalog-resources'
import { toUserMessage } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useFeedbackStore } from '@/stores/feedback'
import type { CatalogDistribution, CatalogResource, CatalogResourceKind, CatalogVersion } from '@/types/catalog-resources'
import type { DeliveryPolicy, MarketType } from '@/types/markets'

export function useCatalogMarket(kind: Ref<CatalogResourceKind>) {
  const auth = useAuthStore()
  const feedback = useFeedbackStore()
  const resources = ref<CatalogResource[]>([])
  const distributions = ref<CatalogDistribution[]>([])
  const loading = ref(false)
  const saving = ref(false)
  const versionSaving = ref(false)
  const drawerOpen = ref(false)
  const editingId = ref('')
  const detail = ref<CatalogResource | null>(null)
  const search = ref('')
  const searchField = ref('all')
  const appliedSearch = ref('')
  const appliedSearchField = ref('all')
  const statusFilter = ref('all')
  const errorMessage = ref('')
  const syncAvailable = ref(false)
  const syncLoading = ref(false)
  const packageFile = ref<File | null>(null)
  
  const meta = computed(() => kind.value === 'skill' ? {
    title: '技能市场', eyebrow: 'Skill market', description: '管理技能信息、ZIP 版本、签名发布和下游分发。', item: '技能',
    permissions: { manage: 'curated_skills.manage', publish: 'curated_skills.publish', distribute: 'curated_skills.distribute' },
  } : {
    title: 'MCP 市场', eyebrow: 'MCP market', description: '管理经过安全校验的 MCP 配置、版本和下游分发。', item: 'MCP',
    permissions: { manage: 'curated_mcps.manage', publish: 'curated_mcps.publish', distribute: 'curated_mcps.distribute' },
  })
  
  const form = reactive({ id: '', name: '', description: '', category: '', tagsText: '', assetUrl: '', distributionType: 'public' as 'public' | 'protected', defaultDeliveryPolicy: 'market' as DeliveryPolicy, marketTypes: ['personal'] as MarketType[] })
  const versionForm = reactive({ version: '1.0.0', releaseNotes: '', minDesktopVersion: '', configMode: 'form' as 'form' | 'json', transport: 'remote' as 'remote' | 'stdio', url: '', command: 'npx', packageName: '', argsText: '-y', envText: '', configText: '{\n  "transport": "remote",\n  "url": ""\n}' })
  const distributionForm = reactive({ enabled: false, selectedVersionId: '', deliveryPolicy: 'market' as DeliveryPolicy, versionPolicy: 'manual' as 'manual' | 'follow_latest', audienceType: 'all' as 'all' | 'membership_cards', membershipCardIds: [] as string[] })
  
  const filteredResources = computed(() => {
    const keyword = appliedSearch.value.toLowerCase()
    return resources.value.filter((item) => (statusFilter.value === 'all' || item.status === statusFilter.value) && (!keyword || ({ id: [item.id], name: [item.name], description: [item.description], category: [item.category], tags: item.tags, version: [item.currentVersion] }[appliedSearchField.value] || [item.id, item.name, item.description, item.category, ...(item.tags || []), item.currentVersion]).some((value) => String(value || '').toLowerCase().includes(keyword))))
  })
  function submitSearch() { appliedSearch.value = search.value.trim(); appliedSearchField.value = searchField.value }
  function resetSearch() { search.value = ''; searchField.value = 'all'; appliedSearch.value = ''; appliedSearchField.value = 'all'; statusFilter.value = 'all' }
  const canManage = computed(() => auth.can(meta.value.permissions.manage))
  const canPublish = computed(() => auth.can(meta.value.permissions.publish))
  const canDistribute = computed(() => auth.can(meta.value.permissions.distribute))
  
  function distributionFor(id: string) {
    return distributions.value.find((item) => (kind.value === 'skill' ? item.skill_id : item.mcp_id) === id)
  }
  
  async function loadAll(showSuccess = false) {
    loading.value = true
    try {
      const [items, distributionRows, sync] = await Promise.all([listCatalogResources(kind.value), listCatalogDistributions(kind.value).catch(() => []), getCatalogSyncStatus(kind.value).catch(() => ({ enabled: false, updateAvailable: false }))])
      resources.value = items
      distributions.value = distributionRows
      syncAvailable.value = Boolean(sync.enabled && sync.updateAvailable)
      if (showSuccess) feedback.notify(`${meta.value.title}已刷新`, 'success')
    } catch (error) { feedback.notify(toUserMessage(error), 'error') }
    finally { loading.value = false }
  }
  
  function resetForms() {
    Object.assign(form, { id: '', name: '', description: '', category: '', tagsText: '', assetUrl: '', distributionType: 'public', defaultDeliveryPolicy: 'market', marketTypes: ['personal'] })
    Object.assign(versionForm, { version: '1.0.0', releaseNotes: '', minDesktopVersion: '', configMode: 'form', transport: 'remote', url: '', command: 'npx', packageName: '', argsText: '-y', envText: '', configText: '{\n  "transport": "remote",\n  "url": ""\n}' })
    Object.assign(distributionForm, { enabled: false, selectedVersionId: '', deliveryPolicy: 'market', versionPolicy: 'manual', audienceType: 'all', membershipCardIds: [] })
    packageFile.value = null; detail.value = null; editingId.value = ''; errorMessage.value = ''
  }
  
  function openCreate() { resetForms(); drawerOpen.value = true }
  
  async function openEdit(item: CatalogResource) {
    resetForms(); editingId.value = item.id; drawerOpen.value = true; saving.value = true
    try {
      detail.value = await getCatalogResource(kind.value, item.id)
      const full = detail.value
      Object.assign(form, { id: full.id, name: full.name, description: full.description, category: full.category, tagsText: (full.tags || []).join(', '), assetUrl: full.coverUrl || full.iconUrl || '', distributionType: full.distributionType || 'public', defaultDeliveryPolicy: full.defaultDeliveryPolicy || 'market', marketTypes: ['personal'] })
      const distribution = distributionFor(item.id)
      Object.assign(distributionForm, { enabled: Boolean(distribution?.enabled), selectedVersionId: distribution?.selected_version_id || full.currentVersionId || '', deliveryPolicy: distribution?.delivery_policy || full.defaultDeliveryPolicy || 'market', versionPolicy: distribution?.version_policy || 'manual', audienceType: distribution?.audienceType || 'all', membershipCardIds: distribution?.membershipCardIds || [] })
      if (kind.value === 'mcp' && full.versions?.[0]?.config) applyConfigToForm(full.versions[0].config)
    } catch (error) { errorMessage.value = toUserMessage(error) }
    finally { saving.value = false }
  }
  
  function closeDrawer() { if (!saving.value && !versionSaving.value) drawerOpen.value = false }
  
  function payload() {
    return { id: form.id.trim(), name: form.name.trim(), description: form.description.trim(), category: form.category.trim(), tags: form.tagsText.split(',').map((item) => item.trim()).filter(Boolean), ...(kind.value === 'skill' ? { coverUrl: form.assetUrl.trim(), distributionType: form.distributionType } : { iconUrl: form.assetUrl.trim() }), defaultDeliveryPolicy: form.defaultDeliveryPolicy, marketTypes: ['personal'] as MarketType[] }
  }
  
  function validateBase() {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(form.id)) return `${meta.value.item} ID 需使用 2–64 位小写字母、数字、短横线或下划线`
    if (!form.name.trim()) return `请输入${meta.value.item}名称`
    if (!form.marketTypes.length) return '至少选择一个投放市场'
    return ''
  }
  
  function upsert(item: CatalogResource) { const index = resources.value.findIndex((row) => row.id === item.id); if (index >= 0) resources.value.splice(index, 1, { ...resources.value[index], ...item }); else resources.value.unshift(item) }
  
  async function saveBase() {
    if (saving.value) return
    errorMessage.value = validateBase(); if (errorMessage.value) return
    saving.value = true
    try {
      const wasEditing = Boolean(editingId.value)
      const saved = wasEditing ? await updateCatalogResource(kind.value, editingId.value, payload()) : await createCatalogResource(kind.value, payload())
      upsert(saved); editingId.value = saved.id; detail.value = await getCatalogResource(kind.value, saved.id).catch(() => saved)
      feedback.notify(`${meta.value.item}“${saved.name}”${wasEditing ? '保存' : '创建'}成功`, 'success')
    } catch (error) { errorMessage.value = toUserMessage(error) }
    finally { saving.value = false }
  }
  
  async function remove(item: CatalogResource) {
    const confirmed = await feedback.confirm({ title: `删除“${item.name}”？`, message: `将同时删除该${meta.value.item}的版本、分发和安装记录，操作不可恢复。`, confirmText: `删除${meta.value.item}`, tone: 'danger' })
    if (!confirmed) return
    try { await deleteCatalogResource(kind.value, item.id); resources.value = resources.value.filter((row) => row.id !== item.id); feedback.notify(`${meta.value.item}“${item.name}”已删除`, 'success') }
    catch (error) { feedback.notify(toUserMessage(error), 'error') }
  }
  
  async function saveVersion() {
    if (!detail.value || versionSaving.value) return
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(versionForm.version)) { errorMessage.value = '版本号必须使用 SemVer，例如 1.0.0'; return }
    versionSaving.value = true; errorMessage.value = ''
    try {
      let version: CatalogVersion
      if (kind.value === 'skill') {
        if (!packageFile.value) throw new Error('请选择技能 ZIP 文件')
        version = await uploadSkillVersion(detail.value.id, { ...versionForm, packageFile: packageFile.value })
      } else {
        let config: unknown
        if (versionForm.configMode === 'form') config = configFromForm()
        else {
          try { config = JSON.parse(versionForm.configText) } catch { throw new Error('MCP 配置不是有效 JSON') }
        }
        version = await createMcpVersion(detail.value.id, { ...versionForm, config })
      }
      detail.value.versions = [version, ...(detail.value.versions || [])]
      feedback.notify(`${meta.value.item}版本 ${version.version} 已保存为草稿`, 'success')
    } catch (error) { errorMessage.value = toUserMessage(error) }
    finally { versionSaving.value = false }
  }
  
  async function publishVersion(version: CatalogVersion) {
    if (!detail.value) return
    const confirmed = await feedback.confirm({ title: `发布版本 ${version.version}？`, message: `发布后该版本将成为${meta.value.item}的当前版本，并可能触发下游更新提示。`, confirmText: '确认发布' })
    if (!confirmed) return
    versionSaving.value = true
    try {
      await publishCatalogVersion(kind.value, detail.value.id, version, ['personal'])
      version.status = 'published'; detail.value.status = 'published'; detail.value.currentVersionId = version.id; detail.value.currentVersion = version.version; distributionForm.selectedVersionId ||= version.id; upsert({ ...detail.value })
      feedback.notify(`${meta.value.item}版本 ${version.version} 发布成功`, 'success')
    } catch (error) { errorMessage.value = toUserMessage(error) }
    finally { versionSaving.value = false }
  }
  
  async function saveDistributionSettings() {
    if (!detail.value || saving.value) return
    if (!distributionForm.selectedVersionId) { errorMessage.value = '请先选择已发布版本'; return }
    saving.value = true
    try {
      const saved = await saveCatalogDistribution(kind.value, detail.value.id, { ...distributionForm, membershipCardIds: [...distributionForm.membershipCardIds] })
      const index = distributions.value.findIndex((item) => (kind.value === 'skill' ? item.skill_id : item.mcp_id) === detail.value?.id)
      if (index >= 0) distributions.value.splice(index, 1, saved); else distributions.value.unshift(saved)
      feedback.notify(`${meta.value.item}“${detail.value.name}”分发设置已保存`, 'success')
    } catch (error) { errorMessage.value = toUserMessage(error) }
    finally { saving.value = false }
  }

  function applyConfigToForm(raw: unknown) {
    if (!raw || typeof raw !== 'object') return
    const config = raw as Record<string, unknown>
    versionForm.configText = JSON.stringify(config, null, 2)
    if (config.transport !== 'remote' && config.transport !== 'stdio') { versionForm.configMode = 'json'; return }
    versionForm.configMode = 'form'; versionForm.transport = config.transport
    if (config.transport === 'remote') { versionForm.url = typeof config.url === 'string' ? config.url : ''; return }
    versionForm.command = config.command === 'uvx' ? 'uvx' : 'npx'
    const args = Array.isArray(config.args) ? config.args.map(String) : []
    versionForm.packageName = args.find((item) => item && !item.startsWith('-') && !item.includes('=')) || ''
    versionForm.argsText = args.filter((item) => item !== versionForm.packageName).join(' ')
    const env = config.env && typeof config.env === 'object' ? config.env as Record<string, unknown> : {}
    versionForm.envText = Object.entries(env).map(([key, value]) => `${key}=${String(value)}`).join('\n')
  }

  function configFromForm() {
    if (versionForm.transport === 'remote') return { transport: 'remote', url: versionForm.url.trim() }
    const args = versionForm.argsText.trim() ? versionForm.argsText.trim().split(/\s+/) : []
    if (versionForm.packageName.trim()) args.push(versionForm.packageName.trim())
    const env: Record<string, string> = {}
    for (const line of versionForm.envText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) { const separator = line.indexOf('='); if (separator > 0) env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim() }
    return { transport: 'stdio', command: versionForm.command, args, env }
  }

  async function setStatus(status: 'published' | 'disabled') {
    if (!detail.value || saving.value || detail.value.status === status) return
    saving.value = true; errorMessage.value = ''
    try {
      const updated = await updateCatalogResourceStatus(kind.value, detail.value.id, status)
      detail.value = { ...detail.value, ...updated }; upsert(updated)
      feedback.notify(`${meta.value.item}已${status === 'published' ? '发布' : '停用'}`, 'success')
    } catch (error) { errorMessage.value = toUserMessage(error) }
    finally { saving.value = false }
  }
  
  async function syncFromCenter() { if (syncLoading.value) return; syncLoading.value = true; try { await startCatalogSync(kind.value); syncAvailable.value = false; feedback.notify(`${meta.value.item}同步任务已创建`, 'success') } catch (error) { feedback.notify(toUserMessage(error), 'error') } finally { syncLoading.value = false } }
  
  watch(() => kind.value, () => { resetForms(); loadAll() })
  onMounted(() => loadAll())

  return {
    resources, loading, saving, versionSaving, drawerOpen, editingId, detail, search, searchField, statusFilter, errorMessage,
    syncAvailable, syncLoading, packageFile, meta, form, versionForm, distributionForm, filteredResources,
    canManage, canPublish, canDistribute, distributionFor, loadAll, openCreate, openEdit, closeDrawer,
    saveBase, remove, saveVersion, publishVersion, saveDistributionSettings, setStatus, syncFromCenter, submitSearch, resetSearch,
  }
}

