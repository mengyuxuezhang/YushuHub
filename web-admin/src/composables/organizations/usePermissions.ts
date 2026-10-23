import { computed, onMounted, reactive, ref } from 'vue'
import * as api from '@/api/organization'
import { toUserMessage } from '@/api/client'
import { useFeedbackStore } from '@/stores/feedback'
import type { AdminAccount, PermissionItem, RoleTemplate, UserGroup } from '@/types/organization'
import { isPermissionGroupFullySelected, togglePermissionGroupSelection } from '@/utils/permission-selection'

export function usePermissions() {
  const feedback = useFeedbackStore()
  const catalog = ref<PermissionItem[]>([])
  const templates = ref<RoleTemplate[]>([])
  const groups = ref<UserGroup[]>([])
  const accounts = ref<AdminAccount[]>([])
  const activeTab = ref<'roles' | 'groups'>('roles')
  const permissionSearch = ref('')
  const listSearch = ref('')
  const listSearchField = ref('all')
  const appliedListSearch = ref('')
  const appliedListSearchField = ref('all')
  const listStatus = ref('all')
  const saving = ref(false)
  const groupSaving = ref(false)
  const drawerOpen = ref(false)
  const groupDrawerOpen = ref(false)
  const errorMessage = ref('')
  const groupError = ref('')
  const form = reactive({ id: '', name: '', description: '', baseRole: 'agent', status: 'enabled', sortOrder: 0, permissionKeys: [] as string[] })
  const groupForm = reactive({ id: '', name: '', description: '', status: 'enabled', userIds: [] as string[], permissionKeys: [] as string[] })
  const groupedCatalog = computed(() => {
    const query = permissionSearch.value.toLowerCase()
    const map = new Map<string, PermissionItem[]>()
    for (const permission of catalog.value.filter((item) => !query || [item.key, item.name, item.description].join(' ').toLowerCase().includes(query))) {
      const group = permission.group || '其他'
      if (!map.has(group)) map.set(group, [])
      map.get(group)!.push(permission)
    }
    return [...map.entries()]
  })
  const filteredTemplates = computed(() => {
    const query = appliedListSearch.value.toLowerCase()
    return templates.value.filter((item) => (listStatus.value === 'all' || item.status === listStatus.value) && (!query || ({ name: [item.name], id: [item.id], description: [item.description], baseRole: [item.baseRole] }[appliedListSearchField.value] || [item.name, item.id, item.description, item.baseRole]).some((value) => String(value || '').toLowerCase().includes(query))))
  })
  const filteredGroups = computed(() => {
    const query = appliedListSearch.value.toLowerCase()
    return groups.value.filter((item) => (listStatus.value === 'all' || item.status === listStatus.value) && (!query || ({ name: [item.name], id: [item.id], description: [item.description] }[appliedListSearchField.value] || [item.name, item.id, item.description]).some((value) => String(value || '').toLowerCase().includes(query))))
  })
  function submitListSearch() { appliedListSearch.value = listSearch.value.trim(); appliedListSearchField.value = listSearchField.value }
  function resetListSearch() { listSearch.value = ''; listSearchField.value = 'all'; appliedListSearch.value = ''; appliedListSearchField.value = 'all'; listStatus.value = 'all' }

  async function load() {
    try {
      ;[catalog.value, templates.value, groups.value, accounts.value] = await Promise.all([
        api.listPermissionCatalog(), api.listRoleTemplates(), api.listUserGroups().catch(() => []), api.listAccounts({ page: 1, pageSize: 100 }).then(result => result.items).catch(() => []),
      ])
    } catch (error) { feedback.notify(toUserMessage(error), 'error') }
  }
  function openCreate() {
    Object.assign(form, { id: '', name: '', description: '', baseRole: 'agent', status: 'enabled', sortOrder: 0, permissionKeys: [] })
    errorMessage.value = ''; drawerOpen.value = true
  }
  function openEdit(template: RoleTemplate) {
    Object.assign(form, {
      id: template.editable === false ? '' : template.id,
      name: template.editable === false ? `${template.name}副本` : template.name,
      description: template.description,
      baseRole: template.baseRole,
      status: template.status,
      sortOrder: template.sortOrder,
      permissionKeys: [...template.permissionKeys],
    })
    errorMessage.value = ''; drawerOpen.value = true
  }
  function isGroupFullySelected(items: PermissionItem[]) {
    return isPermissionGroupFullySelected(form.permissionKeys, items)
  }
  function togglePermissionGroup(items: PermissionItem[]) {
    form.permissionKeys = togglePermissionGroupSelection(form.permissionKeys, items)
  }
  async function save() {
    if (saving.value) return
    if (!form.name.trim()) { errorMessage.value = '请输入岗位模板名称'; return }
    saving.value = true
    try {
      const role = await api.saveRoleTemplate({ ...form, status: form.status as 'enabled' | 'disabled' })
      const saved = await api.saveRolePermissions(role.id, form.permissionKeys)
      const index = templates.value.findIndex((item) => item.id === saved.id)
      if (index >= 0) templates.value.splice(index, 1, saved); else templates.value.push(saved)
      feedback.notify(`岗位“${saved.name}”保存成功`, 'success'); drawerOpen.value = false
    } catch (error) { errorMessage.value = toUserMessage(error) } finally { saving.value = false }
  }
  async function createGroup(name: string) {
    if (!name.trim()) return
    try {
      const created = await api.saveUserGroup({ name, status: 'enabled' })
      groups.value.unshift(created)
      feedback.notify('账号组创建成功，请继续配置成员和权限', 'success')
      await openGroup(created)
    } catch (error) { feedback.notify(toUserMessage(error), 'error') }
  }
  async function openGroup(group: UserGroup) {
    groupError.value = ''
    try {
      const [members, permissions] = await Promise.all([api.listUserGroupMembers(group.id), api.listUserGroupPermissions(group.id)])
      Object.assign(groupForm, { id: group.id, name: group.name, description: group.description, status: group.status, userIds: [...members.userIds], permissionKeys: [...permissions.permissionKeys] })
      groupDrawerOpen.value = true
    } catch (error) { feedback.notify(toUserMessage(error), 'error') }
  }
  async function saveGroup() {
    if (groupSaving.value) return
    if (!groupForm.name.trim()) { groupError.value = '请输入账号组名称'; return }
    groupSaving.value = true; groupError.value = ''
    try {
      const saved = await api.saveUserGroup({ ...groupForm, status: groupForm.status as 'enabled' | 'disabled' })
      await Promise.all([api.saveUserGroupMembers(saved.id, groupForm.userIds), api.saveUserGroupPermissions(saved.id, groupForm.permissionKeys)])
      const index = groups.value.findIndex((item) => item.id === saved.id)
      const next = { ...saved, memberCount: groupForm.userIds.length }
      if (index >= 0) groups.value.splice(index, 1, next)
      feedback.notify(`账号组“${saved.name}”配置已保存`, 'success'); groupDrawerOpen.value = false
    } catch (error) { groupError.value = toUserMessage(error) } finally { groupSaving.value = false }
  }
  async function removeGroup(group: UserGroup) {
    const accepted = await feedback.confirm({ title: `删除账号组“${group.name}”？`, message: '组内仍有成员时服务端会拒绝删除。', confirmText: '删除账号组', tone: 'danger' })
    if (!accepted) return
    try { await api.deleteUserGroup(group.id); groups.value = groups.value.filter((item) => item.id !== group.id); feedback.notify('账号组已删除', 'success') } catch (error) { feedback.notify(toUserMessage(error), 'error') }
  }
  async function removeRole(template: RoleTemplate) {
    const accepted = await feedback.confirm({ title: `删除岗位“${template.name}”？`, message: '正在使用该岗位的账号必须先调整岗位；删除后不可恢复。', confirmText: '删除岗位', tone: 'danger' })
    if (!accepted) return
    try {
      await api.deleteRoleTemplate(template.id)
      templates.value = templates.value.filter((item) => item.id !== template.id)
      feedback.notify(`岗位“${template.name}”已删除`, 'success')
    } catch (error) { feedback.notify(toUserMessage(error), 'error') }
  }
  onMounted(load)
  return { catalog, templates, groups, accounts, activeTab, permissionSearch, listSearch, listSearchField, listStatus, saving, groupSaving, drawerOpen, groupDrawerOpen, errorMessage, groupError, form, groupForm, groupedCatalog, filteredTemplates, filteredGroups, load, openCreate, openEdit, isGroupFullySelected, togglePermissionGroup, save, createGroup, openGroup, saveGroup, removeGroup, removeRole, submitListSearch, resetListSearch }
}
