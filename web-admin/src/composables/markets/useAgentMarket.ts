import { computed, onMounted, reactive, ref } from 'vue'

import { createCuratedAgent, deleteCuratedAgent, getAgentSyncStatus, listAgentDependencyOptions, listAgentDistributions, listCuratedAgents, publishCuratedAgent, saveAgentDistribution, startAgentSync, updateCuratedAgent, updateCuratedAgentStatus } from '@/api/curated-agents'
import { toUserMessage } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useFeedbackStore } from '@/stores/feedback'
import type { AgentDistribution, CuratedAgent, CuratedAgentInput, DeliveryPolicy, MarketDependencyOption } from '@/types/markets'

export function useAgentMarket() {
  const auth = useAuthStore()
  const feedback = useFeedbackStore()
  const agents = ref<CuratedAgent[]>([])
  const distributions = ref<AgentDistribution[]>([])
  const skills = ref<MarketDependencyOption[]>([])
  const mcps = ref<MarketDependencyOption[]>([])
  const loading = ref(false)
  const saving = ref(false)
  const publishingId = ref('')
  const deletingId = ref('')
  const drawerOpen = ref(false)
  const editingId = ref('')
  const formError = ref('')
  const search = ref('')
  const searchField = ref('all')
  const appliedSearch = ref('')
  const appliedSearchField = ref('all')
  const statusFilter = ref('all')
  const syncAvailable = ref(false)
  const syncLoading = ref(false)
  
  const form = reactive<CuratedAgentInput>({ id: '', name: '', description: '', prompt: '', iconUrl: '', publisherName: '', profileLabels: [], usageLabel: '', expertiseTags: [], starterPrompts: [], version: '1.0.0', permissionMode: 'default', skillIds: [], mcpIds: [], marketTypes: ['personal'] })
  const distributionForm = reactive<{ enabled: boolean; deliveryPolicy: DeliveryPolicy; audienceType: 'all' | 'membership_cards'; membershipCardIds: string[] }>({ enabled: false, deliveryPolicy: 'market', audienceType: 'all', membershipCardIds: [] })
  
  const filteredAgents = computed(() => {
    const keyword = appliedSearch.value.toLowerCase()
    return agents.value.filter((agent) => (statusFilter.value === 'all' || agent.status === statusFilter.value)
      && (!keyword || ({ id: [agent.id], name: [agent.name], description: [agent.description], version: [agent.version] }[appliedSearchField.value] || [agent.id, agent.name, agent.description, agent.version]).some((value) => String(value || '').toLowerCase().includes(keyword))))
  })

  function submitSearch() { appliedSearch.value = search.value.trim(); appliedSearchField.value = searchField.value }
  function resetSearch() { search.value = ''; searchField.value = 'all'; appliedSearch.value = ''; appliedSearchField.value = 'all'; statusFilter.value = 'all' }
  
  const currentAgent = computed(() => agents.value.find((item) => item.id === editingId.value) || null)
  const canManage = computed(() => auth.can('curated_agents.manage'))
  const canPublish = computed(() => auth.can('curated_agents.publish'))
  const canDistribute = computed(() => auth.can('curated_agents.distribute'))
  
  function agentDistribution(id: string) {
    return distributions.value.find((item) => (item.agent_id || item.agentId) === id)
  }
  
  async function loadAll(showSuccess = false) {
    loading.value = true
    try {
      const [agentRows, distributionRows, dependencyOptions, sync] = await Promise.all([
        listCuratedAgents(),
        listAgentDistributions().catch(() => []),
        listAgentDependencyOptions(),
        getAgentSyncStatus().catch(() => ({ enabled: false, updateAvailable: false })),
      ])
      agents.value = agentRows
      distributions.value = distributionRows
      skills.value = dependencyOptions.skills
      mcps.value = dependencyOptions.mcps
      syncAvailable.value = Boolean(sync.enabled && sync.updateAvailable)
      if (showSuccess) feedback.notify('专家列表已刷新', 'success')
    } catch (error) {
      feedback.notify(toUserMessage(error), 'error')
    } finally {
      loading.value = false
    }
  }
  
  function resetForm() {
    Object.assign(form, { id: '', name: '', description: '', prompt: '', iconUrl: '', publisherName: '', profileLabels: [], usageLabel: '', expertiseTags: [], starterPrompts: [], version: '1.0.0', permissionMode: 'default', skillIds: [], mcpIds: [], marketTypes: ['personal'] })
    Object.assign(distributionForm, { enabled: false, deliveryPolicy: 'market', audienceType: 'all', membershipCardIds: [] })
    editingId.value = ''
    formError.value = ''
  }
  
  function openCreate() {
    resetForm()
    drawerOpen.value = true
  }
  
  function openEdit(agent: CuratedAgent) {
    editingId.value = agent.id
    Object.assign(form, {
      id: agent.id, name: agent.name, description: agent.description, prompt: agent.prompt, iconUrl: agent.iconUrl || '', publisherName: agent.publisherName || '', profileLabels: [...(agent.profileLabels || [])], usageLabel: agent.usageLabel || '', expertiseTags: [...(agent.expertiseTags || [])], starterPrompts: [...(agent.starterPrompts || [])], version: agent.version,
      permissionMode: 'default', skillIds: agent.dependencies.filter((item) => item.type === 'skill').map((item) => item.id),
      mcpIds: agent.dependencies.filter((item) => item.type === 'mcp').map((item) => item.id), marketTypes: ['personal'],
    })
    const distribution = agentDistribution(agent.id)
    Object.assign(distributionForm, {
      enabled: Boolean(distribution?.enabled), deliveryPolicy: distribution?.delivery_policy || distribution?.deliveryPolicy || 'market',
      audienceType: distribution?.audienceType || 'all', membershipCardIds: distribution?.membershipCardIds || [],
    })
    formError.value = ''
    drawerOpen.value = true
  }
  
  function closeDrawer() {
    if (saving.value) return
    drawerOpen.value = false
  }
  
  function validateForm() {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(form.id)) return '专家 ID 需使用 2–64 位小写字母、数字、短横线或下划线'
    if (!form.name.trim()) return '请输入专家名称'
    if (!form.description.trim()) return '请输入用途说明'
    if (!form.prompt.trim()) return '请输入行为指令'
    if (form.profileLabels.length > 4 || form.profileLabels.some((item) => !item.trim() || item.trim().length > 40)) return '身份标签最多 4 个，每项 1–40 字'
    if (form.expertiseTags.length > 8 || form.expertiseTags.some((item) => !item.trim() || item.trim().length > 40)) return '擅长领域最多 8 个，每项 1–40 字'
    if (form.starterPrompts.length > 6 || form.starterPrompts.some((item) => !item.trim() || item.trim().length > 500)) return '示例问题最多 6 个，每项 1–500 字'
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(form.version)) return '版本号必须使用 SemVer，例如 1.0.0'
    if (!form.marketTypes.length) return '至少选择一个投放市场'
    return ''
  }
  
  function upsertAgent(agent: CuratedAgent) {
    const index = agents.value.findIndex((item) => item.id === agent.id)
    if (index >= 0) agents.value.splice(index, 1, agent)
    else agents.value.unshift(agent)
  }
  
  async function save() {
    if (saving.value) return
    formError.value = validateForm()
    if (formError.value) return
    saving.value = true
    try {
      const payload: CuratedAgentInput = { ...form, name: form.name.trim(), description: form.description.trim(), prompt: form.prompt.trim(), publisherName: form.publisherName.trim(), profileLabels: form.profileLabels.map((item) => item.trim()), usageLabel: form.usageLabel.trim(), expertiseTags: form.expertiseTags.map((item) => item.trim()), starterPrompts: form.starterPrompts.map((item) => item.trim()), marketTypes: ['personal'], skillIds: [...form.skillIds], mcpIds: [...form.mcpIds] }
      if (editingId.value) {
        const agent = await updateCuratedAgent(editingId.value, payload)
        upsertAgent(agent)
        feedback.notify(`专家“${agent.name}”保存成功`, 'success')
      } else {
        const result = await createCuratedAgent(payload)
        upsertAgent(result.agent)
        resetSearch()
        feedback.notify(result.recovered ? `专家“${result.agent.name}”已创建，列表已为你恢复显示` : `专家“${result.agent.name}”创建成功`, 'success', 5200)
      }
      drawerOpen.value = false
    } catch (error) {
      formError.value = toUserMessage(error)
    } finally {
      saving.value = false
    }
  }
  
  async function publish(agent: CuratedAgent) {
    if (publishingId.value) return
    const confirmed = await feedback.confirm({ title: `发布“${agent.name}”？`, message: '发布后会投放到个人市场，下游可能收到更新提示。', confirmText: '确认发布' })
    if (!confirmed) return
    publishingId.value = agent.id
    try {
      await publishCuratedAgent(agent.id, ['personal'])
      upsertAgent({ ...agent, status: 'published' })
      feedback.notify(`专家“${agent.name}”发布成功`, 'success')
    } catch (error) { feedback.notify(toUserMessage(error), 'error') }
    finally { publishingId.value = '' }
  }
  
  async function remove(agent: CuratedAgent) {
    if (deletingId.value) return
    const confirmed = await feedback.confirm({ title: `删除“${agent.name}”？`, message: '这会同时删除该专家的分发和安装记录，操作不可恢复。', confirmText: '删除专家', tone: 'danger' })
    if (!confirmed) return
    deletingId.value = agent.id
    try {
      await deleteCuratedAgent(agent.id)
      agents.value = agents.value.filter((item) => item.id !== agent.id)
      feedback.notify(`专家“${agent.name}”已删除`, 'success')
    } catch (error) { feedback.notify(toUserMessage(error), 'error') }
    finally { deletingId.value = '' }
  }
  
  async function saveDistribution() {
    if (!currentAgent.value || saving.value) return
    saving.value = true
    try {
      const saved = await saveAgentDistribution(currentAgent.value.id, { ...distributionForm, membershipCardIds: [...distributionForm.membershipCardIds] })
      const index = distributions.value.findIndex((item) => (item.agent_id || item.agentId) === currentAgent.value?.id)
      if (index >= 0) distributions.value.splice(index, 1, saved); else distributions.value.unshift(saved)
      feedback.notify(`专家“${currentAgent.value.name}”分发设置已保存`, 'success')
    } catch (error) { formError.value = toUserMessage(error) }
    finally { saving.value = false }
  }

  async function setStatus(status: 'published' | 'disabled') {
    if (!currentAgent.value || saving.value || currentAgent.value.status === status) return
    saving.value = true; formError.value = ''
    try {
      const updated = await updateCuratedAgentStatus(currentAgent.value.id, status)
      upsertAgent(updated); feedback.notify(`专家已${status === 'published' ? '发布' : '停用'}`, 'success')
    } catch (error) { formError.value = toUserMessage(error) }
    finally { saving.value = false }
  }
  
  async function syncFromCenter() {
    if (syncLoading.value) return
    syncLoading.value = true
    try {
      await startAgentSync()
      feedback.notify('专家同步任务已创建，请稍后刷新查看结果', 'success')
      syncAvailable.value = false
    } catch (error) { feedback.notify(toUserMessage(error), 'error') }
    finally { syncLoading.value = false }
  }
  
  onMounted(() => loadAll())

  return {
    agents, skills, mcps, loading, saving, publishingId, deletingId, drawerOpen, editingId, formError,
    search, searchField, statusFilter, syncAvailable, syncLoading, form, distributionForm, filteredAgents, currentAgent,
    canManage, canPublish, canDistribute, agentDistribution, loadAll, openCreate, openEdit, closeDrawer,
    save, publish, remove, saveDistribution, setStatus, syncFromCenter, submitSearch, resetSearch,
  }
}

