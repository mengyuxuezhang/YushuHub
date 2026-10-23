<script setup lang="ts">import DataPagination from '@/components/common/DataPagination.vue';defineProps<{b:any}>()</script>
<template><DataPagination :page="b.page.value" :page-size="b.pageSize.value" :total="b.total.value" :total-pages="b.totalPages.value" :loading="b.loading.value" @update:page="b.setPage" @update:page-size="b.setPageSize" /></template>
