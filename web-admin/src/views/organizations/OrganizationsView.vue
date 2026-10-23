<script setup lang="ts">
import { Building2, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, X } from '@lucide/vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import SearchToolbar from '@/components/common/SearchToolbar.vue'
import OrganizationDrawer from '@/components/organizations/OrganizationDrawer.vue'
import { useOrganizations } from '@/composables/organizations/useOrganizations'
import { formatLicenseExpiry } from '@/utils/supplier-license'

const {
  context, selected, groupedCapabilities, audit, loading, saving, drawerOpen, resetTarget,
  resetPasswordValue, search, searchField, status, errorMessage, activeDetail, form, rows, canCreateChildren,
  canTransferProjectQuota, canTransferBuildQuota, transferableCapabilityMap,
  load, openCreate, openEdit, save, select, isCapabilityGroupFullyEnabled, toggleCapabilityGroup,
  saveCapabilitySelection, resetPassword, confirmResetPassword, remove, submitSearch, resetSearch,
} = useOrganizations()
const searchFields = [{ value: 'all', label: '全部字段' }, { value: 'name', label: '组织名称' }, { value: 'id', label: '组织 ID' }, { value: 'owner', label: '管理员' }]
const isQuotaKey = (key: string) => key === 'projects.manage' || key === 'builds.create'
const quotaUnit = (key: string) => (key === 'projects.manage' ? '个项目' : '次构建')
const parentQuotaLimit = (key: string) => transferableCapabilityMap.value.get(key)?.limitValue || 0
</script>

<template>
  <section class="management-page">
    <header class="page-heading management-heading">
      <div><span class="eyebrow">Organization network</span><h1>组织主体</h1><p>把二级代理、内部成员和数据范围清晰分开，避免账号继续承担组织身份。</p></div>
      <div class="heading-actions"><button class="secondary-button" :disabled="loading" @click="load"><RefreshCw :size="16" />刷新</button><button v-if="canCreateChildren" class="primary-button" @click="openCreate"><Plus :size="17" />新建二级代理</button></div>
    </header>

    <div v-if="context" class="organization-context-strip">
      <div><span>当前主体</span><strong>{{ context.organizationName || context.organizationId }}</strong></div>
      <div><span>渠道层级</span><strong>{{ context.organizationLevel === 0 ? '官方平台' : context.organizationLevel === 1 ? '一级代理' : '二级代理' }}</strong></div>
      <div><span>数据范围</span><strong>{{ context.dataScope }}</strong></div>
      <div><span>部署模式</span><strong>{{ context.deploymentMode }}</strong></div>
    </div>

    <div class="organization-workspace">
      <div>
        <SearchToolbar v-model="search" v-model:field="searchField" :fields="searchFields" placeholder="输入关键词后点击搜索" :loading="loading" :result-text="`共 ${rows.length} 个组织`" @search="submitSearch" @reset="resetSearch"><select v-model="status"><option value="all">全部状态</option><option value="enabled">启用</option><option value="disabled">停用</option></select></SearchToolbar>
        <div class="organization-card-list">
          <button v-for="item in rows" :key="item.id" class="organization-card" :class="{ selected: selected?.id === item.id }" @click="select(item)">
            <span class="entity-avatar"><Building2 :size="19" /></span>
            <span><strong>{{ item.name }}</strong><small>{{ item.ownerDisplayName || item.ownerUsername }} · {{ item.id }}</small><em>二级代理 · 到期：{{ formatLicenseExpiry(item.expiresAt) }}</em></span>
            <StatusBadge :status="item.authorizationStatus || item.status" />
          </button>
          <div v-if="!rows.length" class="empty-state panel-card"><Building2 :size="34" /><h2>暂无直属二级代理</h2><p>内部成员请从“后台账号”添加，不会在这里创建组织。</p></div>
        </div>
      </div>

      <aside class="organization-detail panel-card">
        <div v-if="!selected" class="detail-empty"><ShieldCheck :size="35" /><h2>选择一个组织</h2><p>查看能力授权、管理员和审计记录。</p></div>
        <template v-else>
          <header><div><span class="eyebrow">Level 2 agent</span><h2>{{ selected.name }}</h2><p>{{ selected.id }} · {{ selected.ownerUsername }}</p></div><div class="row-actions"><button class="text-button" @click="openEdit(selected)">编辑资料</button><button class="text-button" @click="resetPassword(selected)">重置密码</button><button class="icon-danger" @click="remove(selected)"><Trash2 :size="16" /></button></div></header>
          <nav class="detail-tabs"><button :class="{ active: activeDetail === 'capabilities' }" @click="activeDetail = 'capabilities'">能力授权</button><button :class="{ active: activeDetail === 'audit' }" @click="activeDetail = 'audit'">审计记录</button></nav>
          <div v-if="activeDetail === 'capabilities'" class="capability-groups">
            <section v-for="[group, items] in groupedCapabilities" :key="group" class="capability-group">
              <header><div><strong>{{ group }}</strong><span>已选 {{ items.filter(item => item.enabled).length }} / {{ items.length }} 项</span></div><button type="button" class="text-button" @click="toggleCapabilityGroup(items)">{{ isCapabilityGroupFullyEnabled(items) ? '清空本组' : '全选本组' }}</button></header>
              <div class="capability-list"><label v-for="item in items" :key="item.key"><input v-model="item.enabled" type="checkbox" /><span><strong>{{ item.name || item.key }}</strong><small>{{ item.description || item.key }}</small></span><span v-if="isQuotaKey(item.key) && item.enabled" class="capability-quota" @click.prevent><input v-model.number="item.limitValue" type="number" min="0" step="1" :max="parentQuotaLimit(item.key) || undefined" :placeholder="parentQuotaLimit(item.key) > 0 ? `不超过 ${parentQuotaLimit(item.key)}` : '0 为不限制'" /><em>{{ quotaUnit(item.key) }}</em></span><em v-else-if="item.limitValue">额度 {{ item.limitValue }}</em></label></div>
            </section>
            <button class="primary-button" :disabled="saving" @click="saveCapabilitySelection">保存能力授权</button>
          </div>
          <div v-else class="audit-list"><article v-for="item in audit" :key="item.id"><strong>{{ item.eventType }}</strong><span>{{ item.actorUserId || '系统' }} · {{ new Date(item.createdAt).toLocaleString('zh-CN') }}</span></article><p v-if="!audit.length" class="muted-empty">暂无审计记录</p></div>
        </template>
      </aside>
    </div>

    <OrganizationDrawer :open="drawerOpen" :form="form" :saving="saving" :error-message="errorMessage" :can-transfer-project-quota="canTransferProjectQuota" :can-transfer-build-quota="canTransferBuildQuota" :project-quota-limit="parentQuotaLimit('projects.manage')" :build-quota-limit="parentQuotaLimit('builds.create')" :parent-expires-at="context?.expiresAt" @close="drawerOpen = false" @save="save" />
    <div v-if="resetTarget" class="dialog-backdrop" @click.self="resetTarget = null"><section class="confirm-dialog password-dialog"><button class="dialog-close" aria-label="关闭" @click="resetTarget = null"><X :size="17" /></button><span class="dialog-icon"><KeyRound :size="23" /></span><h2>重置{{ resetTarget.name }}管理员密码</h2><p>保存后该管理员的现有会话会立即失效。</p><label><span>新密码（至少 8 位）</span><input v-model="resetPasswordValue" type="password" autocomplete="new-password" /></label><div class="dialog-actions"><button class="secondary-button" @click="resetTarget = null">取消</button><button class="primary-button" :disabled="saving || resetPasswordValue.length < 8" @click="confirmResetPassword">确认重置</button></div></section></div>
  </section>
</template>
