<script setup lang="ts">
import { Bot, ChevronRight, CloudDownload, Plus, RefreshCw, Trash2 } from '@lucide/vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import SearchToolbar from '@/components/common/SearchToolbar.vue'
import AgentEditorDrawer from '@/components/markets/AgentEditorDrawer.vue'
import { useAgentMarket } from '@/composables/markets/useAgentMarket'

const {
  agents, skills, mcps, loading, saving, publishingId, deletingId, drawerOpen, editingId, formError,
  search, searchField, statusFilter, syncAvailable, syncLoading, form, distributionForm, filteredAgents, currentAgent,
  canManage, canPublish, canDistribute, agentDistribution, loadAll, openCreate, openEdit, closeDrawer,
  save, publish, remove, saveDistribution, setStatus, syncFromCenter, submitSearch, resetSearch,
} = useAgentMarket()
const searchFields = [{ value: 'all', label: '全部字段' }, { value: 'name', label: '名称' }, { value: 'id', label: '专家 ID' }, { value: 'description', label: '用途说明' }, { value: 'version', label: '版本号' }]
</script>

<template>
  <section class="management-page">
    <header class="page-heading management-heading">
      <div><span class="eyebrow">Capability market</span><h1>专家市场</h1><p>管理专家配置、能力依赖、市场投放和下游分发。</p></div>
      <div class="heading-actions">
        <button v-if="syncAvailable" type="button" class="secondary-button" :disabled="syncLoading" @click="syncFromCenter"><CloudDownload :size="16" />{{ syncLoading ? '同步中…' : '同步总后台更新' }}</button>
        <button type="button" class="secondary-button" :disabled="loading" @click="loadAll(true)"><RefreshCw :size="16" :class="{ spinning: loading }" />刷新</button>
        <button v-if="canManage" type="button" class="primary-button" @click="openCreate"><Plus :size="17" />新建专家</button>
      </div>
    </header>

    <SearchToolbar v-model="search" v-model:field="searchField" :fields="searchFields" placeholder="输入关键词后点击搜索" :loading="loading" :result-text="`共 ${filteredAgents.length} 个专家`" @search="submitSearch" @reset="resetSearch">
      <select v-model="statusFilter" aria-label="状态筛选"><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="disabled">已停用</option></select>
    </SearchToolbar>

    <div class="table-panel panel-card">
      <div v-if="loading && !agents.length" class="table-loading">正在加载专家…</div>
      <div v-else-if="!filteredAgents.length" class="empty-state"><Bot :size="36" /><h2>暂无符合条件的专家</h2><p>{{ agents.length ? '请调整搜索或筛选条件。' : '创建第一个专家，配置技能和 MCP 后再发布到市场。' }}</p><button v-if="canManage && !agents.length" class="primary-button" @click="openCreate"><Plus :size="17" />新建专家</button></div>
      <div v-else class="data-table-scroll">
        <table class="data-table"><thead><tr><th>专家</th><th>版本</th><th>投放市场</th><th>能力依赖</th><th>分发状态</th><th>更新时间</th><th class="action-column">操作</th></tr></thead>
          <tbody><tr v-for="agent in filteredAgents" :key="agent.id">
            <td><div class="entity-cell"><span class="entity-avatar"><img v-if="agent.iconUrl" :src="agent.iconUrl" alt="" /><Bot v-else :size="19" /></span><div><strong>{{ agent.name }}</strong><span>{{ agent.id }}</span><small>{{ agent.description }}</small></div></div></td>
            <td><span class="mono-text">{{ agent.version }}</span><StatusBadge :status="agent.status" /></td>
            <td><div class="tag-list"><span class="soft-tag">个人</span></div></td>
            <td><span>{{ agent.dependencies.length }} 项</span><small class="cell-note">{{ agent.dependencies.filter((item) => item.type === 'skill').length }} 技能 · {{ agent.dependencies.filter((item) => item.type === 'mcp').length }} MCP</small></td>
            <td><StatusBadge :status="agentDistribution(agent.id)?.status || 'disabled'" /></td>
            <td><span class="date-cell">{{ agent.updatedAt ? new Date(agent.updatedAt).toLocaleString('zh-CN') : '—' }}</span></td>
            <td class="action-column"><div class="row-actions"><button type="button" class="text-button" @click="openEdit(agent)">{{ agent.editable ? '编辑' : '查看' }}<ChevronRight :size="15" /></button><button v-if="agent.editable && canPublish && agent.status !== 'published'" type="button" class="text-button" :disabled="publishingId === agent.id" @click="publish(agent)">发布</button><button v-if="agent.editable && canManage" type="button" class="icon-danger" :disabled="deletingId === agent.id" title="删除" @click="remove(agent)"><Trash2 :size="16" /></button></div></td>
          </tr></tbody></table>
      </div>
    </div>

    <AgentEditorDrawer :open="drawerOpen" :editing-id="editingId" :saving="saving" :error-message="formError" :form="form" :distribution-form="distributionForm" :current-agent="currentAgent" :skills="skills" :mcps="mcps" :can-distribute="canDistribute" @close="closeDrawer" @save="save" @save-distribution="saveDistribution" @set-status="setStatus" />
  </section>
</template>


