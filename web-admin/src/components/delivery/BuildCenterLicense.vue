<script setup lang="ts">
import SupplierLicenseNotice from '@/components/organizations/SupplierLicenseNotice.vue'
import { useSupplierLicense } from '@/composables/organizations/useSupplierLicense'
const state = useSupplierLicense()
</script>

<template>
  <SupplierLicenseNotice :license="state.license.value" :now="state.now.value" :loading="state.loading.value" :error="state.error.value" @refresh="state.refresh(true)" />
  <small v-if="!state.license.value">{{ state.error.value || '正在查询授权到期时间…' }}</small>
</template>
