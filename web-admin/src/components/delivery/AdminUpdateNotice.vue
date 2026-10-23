<script setup lang="ts">
import { ArrowRight, RefreshCcw } from '@lucide/vue'

defineProps<{ status: any | null }>()
</script>

<template>
  <aside v-if="status?.updateAvailable" class="admin-update-notice" role="status" aria-live="polite">
    <span><RefreshCcw :size="18" /></span>
    <div><strong>发现管理端新版本 v{{ status.latestVersion }}</strong><p>{{ status.releaseNotes || '请进入系统更新查看版本说明，确认回滚点后再升级。' }}</p></div>
    <RouterLink to="/updates">查看并升级<ArrowRight :size="15" /></RouterLink>
  </aside>
</template>
