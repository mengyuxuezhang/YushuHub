<script setup lang="ts">
import { useCenterSuppliers } from '@/composables/organizations/useCenterSuppliers'
const supplier = useCenterSuppliers()
</script>
<template>
  <section class="management-page">
    <header class="page-heading"><div><h1>官方业务接入记录</h1><p>仅查看构建和资源业务的接入记录。代理授权、套餐、续期及部署绑定统一在独立授权中心管理。</p></div><button class="secondary-button" :disabled="supplier.loading.value" @click="supplier.load">刷新</button></header>
    <label>搜索名称或编号 <input v-model="supplier.search.value" /></label>
    <p v-if="supplier.errorMessage.value" role="alert">{{ supplier.errorMessage.value }}</p>
    <div class="table-panel panel-card"><table class="data-table"><thead><tr><th>经营主体</th><th>业务编号</th><th>最近连接</th></tr></thead><tbody><tr v-for="item in supplier.rows.value" :key="item.id"><td>{{ item.name }}</td><td>{{ item.id }}</td><td>{{ item.lastSeenAt || '—' }}</td></tr></tbody></table><p v-if="!supplier.rows.value.length">暂无接入记录</p></div>
  </section>
</template>
