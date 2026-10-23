<script setup lang="ts">
import { Download, RefreshCw } from '@lucide/vue'
import DataPagination from '@/components/common/DataPagination.vue'
import UsageUsersTable from '@/components/business/UsageUsersTable.vue'
import UsageTrend from '@/components/business/UsageTrend.vue'
import UsageDetailDrawer from '@/components/business/UsageDetailDrawer.vue'
import { useUserUsage } from '@/composables/business/useUserUsage'
import { usageNumber as num, usageTypes } from '@/utils/user-usage'
import '@/styles/user-usage.css'
const r = useUserUsage()
</script>
<template>
  <section class="management-page usage-page">
    <header class="page-heading"><div><h1>用户使用报表</h1><p>查看每个人用了多少、消耗多少积分，以及常用模型。</p></div><div class="heading-actions"><button class="secondary-button" :disabled="r.loading.value" @click="r.load"><RefreshCw :size="16" />刷新</button><button v-if="r.auth.can('user_usage.export')" class="primary-button" :disabled="r.exporting.value || r.loading.value" @click="r.exportCsv"><Download :size="16" />{{ r.exporting.value ? '正在导出…' : '导出 CSV' }}</button></div></header>
    <form class="panel-card usage-filters" @submit.prevent="r.apply">
      <div class="usage-presets"><button v-for="item in [{id:'today',name:'今天'},{id:'week',name:'近 7 天'},{id:'month30',name:'最近 30 天'},{id:'month',name:'本月'}]" :key="item.id" type="button" class="secondary-button" @click="r.preset(item.id)">{{ item.name }}</button><span>北京时间 · 最多 366 天</span></div>
      <div class="usage-filter-fields">
        <label>开始日期<input v-model="r.filters.startDate" type="date" required /></label><label>结束日期<input v-model="r.filters.endDate" type="date" required /></label>
        <label>用户搜索<input v-model="r.filters.search" placeholder="账号、姓名或邮箱" /></label>
        <label>所属项目<select v-model="r.filters.projectId"><option value="">全部项目</option><option v-for="item in r.options.value.projects" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <label>模型<select v-model="r.filters.model"><option value="">全部模型</option><option v-for="item in r.options.value.models" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <label>使用类型<select v-model="r.filters.type"><option value="">全部类型</option><option v-for="(name,id) in usageTypes" :key="id" :value="id">{{ name }}</option></select></label>
        <label>排序<select v-model="r.filters.sort"><option value="points">消耗积分从高到低</option><option value="requests">使用次数从高到低</option><option value="lastUsed">最后使用时间从近到远</option></select></label>
        <div class="usage-filter-actions"><button class="primary-button" :disabled="r.loading.value">查询</button><button type="button" class="secondary-button" @click="r.reset">重置</button></div>
      </div>
      <p v-if="r.filters.userId" class="usage-context">正在查看指定用户，点击重置可查看全部授权用户。</p>
      <p v-if="r.optionError.value" role="alert">{{ r.optionError.value }} <button type="button" class="text-button" @click="r.loadOptions">重试</button></p>
    </form>
    <div v-if="r.error.value" class="panel-card usage-error" role="alert">{{ r.error.value }}<button class="secondary-button" @click="r.load">重试</button></div>
    <p class="usage-context">统计期间：{{ r.applied.value.startDate }} 至 {{ r.applied.value.endDate }}。选择模型或类型时仅显示有匹配使用的用户。</p>
    <div v-if="r.overview.value" class="usage-summary"><article class="panel-card"><span>使用人数</span><strong>{{ num(r.overview.value.summary.users) }}</strong></article><article class="panel-card"><span>已完成模型请求</span><strong>{{ num(r.overview.value.summary.requests) }}</strong></article><article class="panel-card"><span>消耗积分</span><strong>{{ num(r.overview.value.summary.points) }}</strong></article></div>
    <UsageTrend v-if="r.overview.value" :items="r.overview.value.trend" />
    <section class="panel-card table-panel"><p v-if="r.loading.value" class="usage-empty" role="status">正在加载用户用量…</p><template v-else-if="!r.error.value"><UsageUsersTable v-if="r.data.value.items.length" :items="r.data.value.items" @detail="r.openDetail" /><p v-else class="usage-empty">没有符合筛选条件的用户。</p><DataPagination :page="r.page.value" :page-size="r.pageSize.value" :total="r.data.value.total" :total-pages="r.data.value.totalPages" @update:page="r.setPage" @update:page-size="r.setPageSize" /></template></section>
    <section v-if="r.overview.value" class="panel-card usage-notes"><h2>统计口径与数据完整性</h2><p v-for="note in r.overview.value.notes" :key="note">{{ note }}</p><p v-if="Object.values(r.overview.value.summary.completeness).some(value => value > 0)">部分历史请求缺少计量，相关用户的对应用量显示“未记录”，不会把不完整的小计当作完整用量。</p></section>
    <UsageDetailDrawer :open="Boolean(r.detailId.value)" :data="r.detail.value" :loading="r.detailLoading.value" :error="r.detailError.value" @close="r.closeDetail" @retry="r.loadDetail" @page="r.setCallPage" @page-size="r.setCallPageSize" />
  </section>
</template>
