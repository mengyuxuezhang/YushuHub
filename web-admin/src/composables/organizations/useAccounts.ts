import { computed, onMounted, reactive, ref } from 'vue'
import * as api from '@/api/organization'
import { toUserMessage } from '@/api/client'
import { useFeedbackStore } from '@/stores/feedback'
import type { AdminAccount, PermissionItem, PermissionPreview, RoleTemplate } from '@/types/organization'

const sourceModeNames: Record<string, string> = { role_template: '岗位模板', group_override: '账号组覆盖', fallback_role: '默认岗位' }
const dataScopeNames: Record<string, string> = { self: '仅当前组织', children: '直属下级', subtree: '全部下级', platform: '全平台' }

export function useAccounts() {
  const feedback = useFeedbackStore()
  const accounts = ref<AdminAccount[]>([]), templates = ref<RoleTemplate[]>([]), catalog = ref<PermissionItem[]>([])
  const preview = ref<PermissionPreview | null>(null)
  const loading = ref(false), saving = ref(false), drawerOpen = ref(false), previewOpen = ref(false)
  const search = ref(''), searchField = ref('all'), appliedSearch = ref(''), appliedSearchField = ref('all'), status = ref('all'), errorMessage = ref('')
  const page = ref(1), pageSize = ref(20), total = ref(0), totalPages = ref(1)
  const form = reactive({ id: '', username: '', displayName: '', password: '', roleTemplateId: '', status: 'enabled' })
  const rows = computed(() => accounts.value)
  const permissionNames = computed(() => new Map(catalog.value.map(item => [item.key, item.name])))
  const templateName = (id: string) => templates.value.find(x => x.id === id)?.name || id || '未配置'
  const permissionName = (key: string) => key === '*' ? '全部权限' : permissionNames.value.get(key) || `未知权限（${key}）`
  const sourceModeName = (value: string) => sourceModeNames[value] || '岗位与账号组综合计算'
  const dataScopeName = (value: string) => dataScopeNames[value] || value || '未配置'

  async function load() {
    loading.value = true
    try {
      const [result, nextTemplates, nextCatalog] = await Promise.all([
        api.listAccounts({ page: page.value, pageSize: pageSize.value, search: appliedSearch.value, searchField: appliedSearchField.value, status: status.value }),
        templates.value.length ? Promise.resolve(templates.value) : api.listRoleTemplates(),
        catalog.value.length ? Promise.resolve(catalog.value) : api.listPermissionCatalog(),
      ])
      accounts.value = result.items; page.value = result.page; pageSize.value = result.pageSize; total.value = result.total; totalPages.value = result.totalPages
      templates.value = nextTemplates; catalog.value = nextCatalog
    } catch (e) { feedback.notify(toUserMessage(e), 'error') } finally { loading.value = false }
  }
  function openCreate() { Object.assign(form, { id: '', username: '', displayName: '', password: '', roleTemplateId: templates.value.find(x => x.status === 'enabled')?.id || '', status: 'enabled' }); errorMessage.value = ''; drawerOpen.value = true }
  function openEdit(x: AdminAccount) { Object.assign(form, { id: x.id, username: x.username, displayName: x.displayName, password: '', roleTemplateId: x.roleTemplateId, status: x.status }); errorMessage.value = ''; drawerOpen.value = true }
  async function save() { if (saving.value) return; if (!form.username || !form.displayName || !form.roleTemplateId || (!form.id && form.password.length < 8)) { errorMessage.value = '请填写账号、显示名称、岗位模板，新账号密码至少 8 位'; return } saving.value = true; try { const x = await api.saveAccount(form); feedback.notify(`内部成员“${x.displayName}”保存成功`, 'success'); drawerOpen.value = false; await load() } catch (e) { errorMessage.value = toUserMessage(e) } finally { saving.value = false } }
  async function showPreview(x: AdminAccount) { try { preview.value = await api.getPermissionPreview(x.id); previewOpen.value = true } catch (e) { feedback.notify(toUserMessage(e), 'error') } }
  async function remove(x: AdminAccount) { const ok = await feedback.confirm({ title: `删除成员“${x.displayName}”？`, message: '只删除登录身份，不转移或删除所属组织资源。', confirmText: '删除成员', tone: 'danger' }); if (!ok) return; try { await api.deleteAccount(x.id); if (rows.value.length === 1 && page.value > 1) page.value -= 1; await load(); feedback.notify('内部成员已删除', 'success') } catch (e) { feedback.notify(toUserMessage(e), 'error') } }
  async function setPage(value: number) { page.value = value; await load() }
  async function setPageSize(value: number) { pageSize.value = value; page.value = 1; await load() }
  async function submitSearch() { appliedSearch.value = search.value.trim(); appliedSearchField.value = searchField.value; page.value = 1; await load() }
  async function resetSearch() { search.value = ''; searchField.value = 'all'; appliedSearch.value = ''; appliedSearchField.value = 'all'; status.value = 'all'; page.value = 1; await load() }
  onMounted(load)
  return { accounts, templates, preview, loading, saving, drawerOpen, previewOpen, search, searchField, status, errorMessage, form, rows, page, pageSize, total, totalPages, templateName, permissionName, sourceModeName, dataScopeName, load, setPage, setPageSize, submitSearch, resetSearch, openCreate, openEdit, save, showPreview, remove }
}
