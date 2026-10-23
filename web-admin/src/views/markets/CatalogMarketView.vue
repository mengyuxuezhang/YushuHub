<script setup lang="ts">
import { computed, toRef } from 'vue'
import { Boxes, ChevronRight, CloudDownload, Plus, RefreshCw, Sparkles, Trash2 } from '@lucide/vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import SearchToolbar from '@/components/common/SearchToolbar.vue'
import CatalogEditorDrawer from '@/components/markets/CatalogEditorDrawer.vue'
import { useCatalogMarket } from '@/composables/markets/useCatalogMarket'
import type { CatalogResourceKind } from '@/types/catalog-resources'

const props = defineProps<{ kind: CatalogResourceKind }>()
const kind = toRef(props, 'kind')
const metaIcon = computed(() => kind.value === 'skill' ? Sparkles : Boxes)
const {
  resources, loading, saving, versionSaving, drawerOpen, editingId, detail, search, searchField, statusFilter, errorMessage,
  syncAvailable, syncLoading, packageFile, meta, form, versionForm, distributionForm, filteredResources,
  canManage, canPublish, canDistribute, distributionFor, loadAll, openCreate, openEdit, closeDrawer,
  saveBase, remove, saveVersion, publishVersion, saveDistributionSettings, setStatus, syncFromCenter, submitSearch, resetSearch,
} = useCatalogMarket(kind)
const searchFields = [{ value: 'all', label: '全部字段' }, { value: 'name', label: '名称' }, { value: 'id', label: '资源 ID' }, { value: 'category', label: '分类' }, { value: 'tags', label: '标签' }, { value: 'version', label: '当前版本' }, { value: 'description', label: '说明' }]
</script>

<template>
  <section class="management-page">
    <header class="page-heading management-heading"><div><span class="eyebrow">{{ meta.eyebrow }}</span><h1>{{ meta.title }}</h1><p>{{ meta.description }}</p></div><div class="heading-actions"><button v-if="syncAvailable" class="secondary-button" :disabled="syncLoading" @click="syncFromCenter"><CloudDownload :size="16" />同步总后台</button><button class="secondary-button" :disabled="loading" @click="loadAll(true)"><RefreshCw :size="16" :class="{ spinning: loading }" />刷新</button><button v-if="canManage" class="primary-button" @click="openCreate"><Plus :size="17" />新建{{ meta.item }}</button></div></header>
    <SearchToolbar v-model="search" v-model:field="searchField" :fields="searchFields" :placeholder="`输入${meta.item}关键词后点击搜索`" :loading="loading" :result-text="`共 ${filteredResources.length} 项`" @search="submitSearch" @reset="resetSearch"><select v-model="statusFilter" aria-label="状态筛选"><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="disabled">已停用</option></select></SearchToolbar>
    <div class="table-panel panel-card"><div v-if="loading && !resources.length" class="table-loading">正在加载…</div><div v-else-if="!filteredResources.length" class="empty-state"><component :is="metaIcon" :size="36" /><h2>暂无{{ meta.item }}</h2><p>创建基本信息后，再添加和发布版本。</p><button v-if="canManage" class="primary-button" @click="openCreate"><Plus :size="17" />新建{{ meta.item }}</button></div><div v-else class="data-table-scroll"><table class="data-table resource-table"><thead><tr><th>{{ meta.item }}</th><th>分类与标签</th><th>当前版本</th><th>状态</th><th>分发</th><th>更新时间</th><th class="action-column">操作</th></tr></thead><tbody><tr v-for="item in filteredResources" :key="item.id"><td><div class="entity-cell"><span class="entity-avatar"><img v-if="item.coverUrl || item.iconUrl" :src="item.coverUrl || item.iconUrl" alt="" /><component :is="metaIcon" v-else :size="19" /></span><div><strong>{{ item.name }}</strong><span>{{ item.id }}</span><small>{{ item.description || '暂无说明' }}</small></div></div></td><td><strong>{{ item.category || '未分类' }}</strong><div class="tag-list"><span v-for="tag in item.tags.slice(0, 3)" :key="tag" class="soft-tag">{{ tag }}</span></div></td><td><span class="mono-text">{{ item.currentVersion || (item.currentVersionId ? '已配置' : '—') }}</span></td><td><StatusBadge :status="item.status" /></td><td><StatusBadge :status="distributionFor(item.id)?.status || 'disabled'" /></td><td><span class="date-cell">{{ item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN') : '—' }}</span></td><td class="action-column"><div class="row-actions"><button class="text-button" @click="openEdit(item)">管理<ChevronRight :size="15" /></button><button v-if="canManage && !item.systemBuiltin && item.sourceType !== 'official_sync'" class="icon-danger" title="删除" @click="remove(item)"><Trash2 :size="16" /></button></div></td></tr></tbody></table></div></div>

    <CatalogEditorDrawer :open="drawerOpen" :kind="kind" :meta="meta" :editing-id="editingId" :saving="saving" :version-saving="versionSaving" :detail="detail" :form="form" :version-form="versionForm" :distribution-form="distributionForm" :package-file="packageFile" :error-message="errorMessage" :can-manage="canManage" :can-publish="canPublish" :can-distribute="canDistribute" @close="closeDrawer" @save-base="saveBase" @package-file="packageFile = $event" @save-version="saveVersion" @publish-version="publishVersion" @save-distribution="saveDistributionSettings" @set-status="setStatus" />
  </section>
</template>




