<script setup lang="ts">
import { Activity, RefreshCw, ShieldCheck } from '@lucide/vue'

defineProps<{ clock: Date; loadedAt?: string; loading: boolean; organization: string }>()
defineEmits<{ refresh: [] }>()
</script>

<template>
  <header class="cockpit-header">
    <div class="cockpit-title">
      <span class="cockpit-live"><i></i><Activity :size="14" /> LIVE OPERATIONS</span>
      <h1>运营驾驶舱</h1>
      <p>{{ organization }} · 全局业务与交付态势</p>
    </div>
    <div class="cockpit-header-status">
      <div class="cockpit-secure"><ShieldCheck :size="16" /><span><strong>数据安全隔离</strong><small>当前组织权限范围</small></span></div>
      <time><strong>{{ clock.toLocaleTimeString('zh-CN', { hour12: false }) }}</strong><span>{{ clock.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }) }}</span></time>
      <button type="button" class="cockpit-refresh" :disabled="loading" @click="$emit('refresh')"><RefreshCw :size="17" :class="{ spinning: loading }" />{{ loading ? '同步中' : '刷新态势' }}</button>
    </div>
  </header>
</template>
