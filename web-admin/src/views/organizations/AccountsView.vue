<script setup lang="ts">
import {
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRoundCog,
  X,
} from "@lucide/vue";
import StatusBadge from "@/components/common/StatusBadge.vue";
import DataPagination from "@/components/common/DataPagination.vue";
import SearchToolbar from "@/components/common/SearchToolbar.vue";
import AccountDrawer from "@/components/organizations/AccountDrawer.vue";
import { useAccounts } from "@/composables/organizations/useAccounts";
const {
  templates,
  preview,
  loading,
  saving,
  drawerOpen,
  previewOpen,
  search,
  searchField,
  status,
  errorMessage,
  form,
  rows,
  page,
  pageSize,
  total,
  totalPages,
  templateName,
  permissionName,
  sourceModeName,
  dataScopeName,
  load,
  setPage,
  setPageSize,
  submitSearch,
  resetSearch,
  openCreate,
  openEdit,
  save,
  showPreview,
  remove,
} = useAccounts();
</script>
<template>
  <section class="management-page">
    <header class="page-heading management-heading">
      <div>
        <span class="eyebrow">Internal members</span>
        <h1>后台账号</h1>
        <p>这里只管理组织内部成员；创建下级代理请前往“组织主体”。</p>
      </div>
      <div class="heading-actions">
        <button class="secondary-button" :disabled="loading" @click="load">
          <RefreshCw :size="16" />刷新</button
        ><button class="primary-button" @click="openCreate">
          <Plus :size="17" />新增内部成员
        </button>
      </div>
    </header>
    <div class="member-guidance">
      <UserRoundCog :size="21" />
      <div>
        <strong>账号不是数据主体</strong
        ><span
          >停用、调岗或删除成员不会改变项目、订单、Key
          和市场内容的组织归属。</span
        >
      </div>
    </div>
    <SearchToolbar
      v-model="search"
      v-model:field="searchField"
      :fields="[
        { value: 'all', label: '全部字段' },
        { value: 'account', label: '账号 / 姓名' },
        { value: 'accountId', label: '账号 ID' },
        { value: 'role', label: '岗位模板' },
        { value: 'organization', label: '组织 ID' },
      ]"
      :loading="loading"
      placeholder="请输入后台账号搜索关键词"
      :result-text="`共 ${total} 名成员`"
      @search="submitSearch"
      @reset="resetSearch"
    >
      <select v-model="status" aria-label="账号状态" @change="submitSearch">
        <option value="all">全部状态</option>
        <option value="enabled">启用</option>
        <option value="disabled">停用</option>
      </select>
    </SearchToolbar>
    <div class="table-panel panel-card">
      <div v-if="loading && !rows.length" class="table-loading">
        正在加载成员…
      </div>
      <div v-else class="data-table-scroll">
        <table class="data-table member-table">
          <thead>
            <tr>
              <th>内部成员</th>
              <th>岗位模板</th>
              <th>数据范围</th>
              <th>状态</th>
              <th>更新时间</th>
              <th class="action-column">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in rows" :key="item.id">
              <td>
                <div class="entity-cell">
                  <span class="entity-avatar"><UserRoundCog :size="18" /></span>
                  <div>
                    <strong>{{ item.displayName }}</strong
                    ><span>{{ item.username }}</span
                    ><small>{{ item.primaryOrganizationId }}</small>
                  </div>
                </div>
              </td>
              <td>{{ templateName(item.roleTemplateId) }}</td>
              <td>
                <span class="scope-pill">{{
                  item.dataScope || "由岗位计算"
                }}</span>
              </td>
              <td><StatusBadge :status="item.status" /></td>
              <td>
                <span class="date-cell">{{
                  item.updatedAt
                    ? new Date(item.updatedAt).toLocaleString("zh-CN")
                    : "—"
                }}</span>
              </td>
              <td class="action-column">
                <div class="row-actions">
                  <button class="text-button" @click="showPreview(item)">
                    权限预览</button
                  ><button class="text-button" @click="openEdit(item)">
                    编辑</button
                  ><button class="icon-danger" @click="remove(item)">
                    <Trash2 :size="16" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <DataPagination
        :page="page"
        :page-size="pageSize"
        :total="total"
        :total-pages="totalPages"
        :loading="loading"
        @update:page="setPage"
        @update:page-size="setPageSize"
      />
    </div>
    <AccountDrawer
      :open="drawerOpen"
      :form="form"
      :templates="templates"
      :saving="saving"
      :error-message="errorMessage"
      @close="drawerOpen = false"
      @save="save"
    />
    <div
      v-if="previewOpen && preview"
      class="drawer-backdrop-v2"
      @click.self="previewOpen = false"
    >
      <aside class="form-drawer-v2 preview-drawer">
        <header class="drawer-header">
          <div>
            <span class="eyebrow">Effective access</span>
            <h2>{{ preview.user.displayName }}的最终权限</h2>
          </div>
          <button class="icon-button" @click="previewOpen = false">
            <X :size="18" />
          </button>
        </header>
        <div class="drawer-body">
          <div class="permission-equation">
            <span>岗位权限</span><b>∩</b><span>账号组权限</span><b>∩</b
            ><span>组织能力</span><b>∩</b><span>数据范围</span>
          </div>
          <section class="form-section">
            <div class="section-heading">
              <span><ShieldCheck :size="15" /></span>
              <div>
                <h3>授权结论</h3>
                <p>
                  来源：{{ sourceModeName(preview.sourceMode) }} · 数据范围：{{
                    dataScopeName(preview.organizationContext.dataScope)
                  }}
                </p>
              </div>
            </div>
            <div class="permission-chip-list">
              <span v-for="key in preview.effectivePermissionKeys" :key="key">{{
                permissionName(key)
              }}</span>
            </div>
          </section>
        </div>
      </aside>
    </div>
  </section>
</template>
