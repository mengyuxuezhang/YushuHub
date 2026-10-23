<script setup lang="ts">
import { computed, ref } from 'vue'
import { Plus, Search, ShieldCheck, Trash2, X } from '@lucide/vue'
import GroupDrawer from '@/components/organizations/GroupDrawer.vue'
import SearchToolbar from '@/components/common/SearchToolbar.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { usePermissions } from '@/composables/organizations/usePermissions'

const {
  accounts, activeTab, catalog, drawerOpen, errorMessage, filteredGroups, filteredTemplates,
  form, groupDrawerOpen, groupError, groupForm, groupedCatalog, groupSaving, listSearch,
  listSearchField, listStatus, permissionSearch, saving, createGroup, isGroupFullySelected,
  openCreate, openEdit, openGroup, removeGroup, removeRole, resetListSearch, save, saveGroup,
  submitListSearch, togglePermissionGroup,
} = usePermissions()
const groupName = ref('')
const searchFields = computed(() => activeTab.value === 'roles'
  ? [{ value: 'all', label: '全部字段' }, { value: 'name', label: '岗位名称' }, { value: 'id', label: '岗位 ID' }, { value: 'description', label: '岗位说明' }, { value: 'baseRole', label: '基础角色' }]
  : [{ value: 'all', label: '全部字段' }, { value: 'name', label: '账号组名称' }, { value: 'id', label: '账号组 ID' }, { value: 'description', label: '账号组说明' }])
async function submitGroup() { await createGroup(groupName.value); groupName.value = '' }
</script>

<template>
  <section class="management-page">
    <header class="page-heading">
      <div><span class="eyebrow">Roles & access</span><h1>角色与权限</h1><p>通过岗位和账号组配置成员可以使用的后台功能。</p></div>
      <button v-if="activeTab === 'roles'" class="primary-button" @click="openCreate"><Plus :size="17" />新建岗位模板</button>
    </header>
    <div class="permission-explanation"><strong>账号权限是怎么生效的？</strong><p>岗位提供基础权限，账号组可以为一批账号追加权限。账号最终能否执行操作，还会受到所属组织的能力授权和本人数据范围限制。</p><span>在“后台账号”的权限预览中，可以查看该账号最终能够使用的全部权限。</span></div>
    <nav class="page-tabs"><button :class="{ active: activeTab === 'roles' }" @click="activeTab = 'roles'; resetListSearch()">岗位模板</button><button :class="{ active: activeTab === 'groups' }" @click="activeTab = 'groups'; resetListSearch()">账号组</button></nav>
    <SearchToolbar v-model="listSearch" v-model:field="listSearchField" :fields="searchFields" placeholder="输入关键词后点击搜索" :result-text="`共 ${activeTab === 'roles' ? filteredTemplates.length : filteredGroups.length} 项`" @search="submitListSearch" @reset="resetListSearch">
      <select v-model="listStatus" aria-label="状态筛选"><option value="all">全部状态</option><option value="enabled">启用</option><option value="disabled">停用</option></select>
    </SearchToolbar>

    <div v-if="activeTab === 'roles'" class="role-grid">
      <article v-for="item in filteredTemplates" :key="item.id" class="panel-card role-card">
        <header><span class="role-icon"><ShieldCheck :size="18" /></span><StatusBadge :status="item.status" /></header>
        <h2>{{ item.name }}</h2><p>{{ item.description || '暂无岗位说明' }}</p>
        <div><span>{{ item.permissionKeys.length }} 项权限</span><span>{{ item.systemBuiltin ? '系统模板' : '组织模板' }}</span></div>
        <footer class="role-actions"><button class="secondary-button" @click="openEdit(item)">{{ item.editable === false ? '复制为组织岗位' : '编辑岗位' }}</button><button v-if="item.deletable !== false" class="icon-danger" title="删除岗位" @click="removeRole(item)"><Trash2 :size="16" /></button></footer>
      </article>
    </div>
    <div v-else class="group-workspace">
      <section class="panel-card group-create"><h2>新增账号组</h2><p>账号组用于为多个成员追加相同权限，不改变成员所属组织。</p><div><input v-model.trim="groupName" placeholder="例如 财务报表组" /><button class="primary-button" :disabled="!groupName" @click="submitGroup"><Plus :size="16" />创建</button></div></section>
      <section class="panel-card group-list"><article v-for="item in filteredGroups" :key="item.id"><button class="group-open" @click="openGroup(item)"><strong>{{ item.name }}</strong><span>{{ item.memberCount }} 名成员 · {{ item.description || '点击配置成员和权限' }}</span></button><StatusBadge :status="item.status" /><button class="icon-danger" @click="removeGroup(item)"><Trash2 :size="16" /></button></article><p v-if="!filteredGroups.length" class="muted-empty">暂无符合条件的账号组</p></section>
    </div>

    <div v-if="drawerOpen" class="drawer-backdrop-v2">
      <aside class="form-drawer-v2 permission-drawer">
        <header class="drawer-header"><div><span class="eyebrow">Position template</span><h2>{{ form.id ? '编辑岗位模板' : '新建岗位模板' }}</h2></div><button class="icon-button" @click="drawerOpen = false"><X :size="18" /></button></header>
        <div class="drawer-body">
          <section class="form-section"><div class="form-grid-v2"><label><span>模板名称</span><input v-model.trim="form.name" /></label><label><span>状态</span><select v-model="form.status"><option value="enabled">启用</option><option value="disabled">停用</option></select></label></div><label><span>岗位说明</span><textarea v-model.trim="form.description" rows="3" /></label></section>
          <section class="form-section permission-picker"><div class="search-control"><Search :size="16" /><input v-model="permissionSearch" placeholder="搜索权限名称或说明" /></div><div v-for="[group, items] in groupedCatalog" :key="group" class="permission-group"><h3><span>{{ group }} <small>{{ items.filter(x => form.permissionKeys.includes(x.key)).length }}/{{ items.length }}</small></span><button type="button" class="text-button" @click="togglePermissionGroup(items)">{{ isGroupFullySelected(items) ? '清空本组' : '全选本组' }}</button></h3><label v-for="item in items" :key="item.key"><input v-model="form.permissionKeys" type="checkbox" :value="item.key" /><span><strong>{{ item.name }}</strong><small>{{ item.description || item.key }}</small></span></label></div></section>
          <p v-if="errorMessage" class="drawer-error">{{ errorMessage }}</p>
        </div>
        <footer class="drawer-footer"><span>{{ form.permissionKeys.length }} 项已选权限</span><button class="primary-button" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存岗位模板' }}</button></footer>
      </aside>
    </div>
    <GroupDrawer :open="groupDrawerOpen" :form="groupForm" :accounts="accounts" :catalog="catalog" :saving="groupSaving" :error-message="groupError" @close="groupDrawerOpen = false" @save="saveGroup" />
  </section>
</template>
