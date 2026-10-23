<script setup lang="ts">
import { RefreshCw, X } from '@lucide/vue'
import { computed } from 'vue'
import BuildArtifactLinks from '@/components/delivery/BuildArtifactLinks.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'

const props = defineProps<{ open: boolean; build: any | null; stage: string; percent: number }>()
const emit = defineEmits<{ close: []; refresh: [] }>()
const logText = computed(() => String(props.build?.log || props.build?.error || '任务已创建，正在等待构建机输出日志…').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ''))
</script>

<template>
  <div v-if="open && build" class="drawer-backdrop-v2" @click.self="$emit('close')"><aside class="build-log-drawer-v2" role="dialog" aria-label="构建日志">
    <header><div><span class="eyebrow">Build activity</span><h2>构建日志</h2><p>{{ build.projectName || build.projectId }} · {{ build.version ? `v${build.version}` : '等待分配版本' }}</p></div><button class="icon-button" @click="$emit('close')"><X :size="18" /></button></header>
    <section class="build-log-summary"><div><StatusBadge :status="build.status" /><strong>{{ stage }}</strong><span>{{ percent }}%</span></div><div class="build-progress"><i :style="{ width: `${percent}%` }"></i></div><small>{{ new Date(build.updatedAt || build.createdAt).toLocaleString('zh-CN') }} · {{ build.delegatedToCenter ? '官方构建中心' : '本地 Worker' }}</small></section>
    <div class="build-log-toolbar"><span>任务 ID：<code>{{ build.id }}</code></span><div><button class="secondary-button" @click="$emit('refresh')"><RefreshCw :size="15" />刷新</button></div></div>
    <BuildArtifactLinks v-if="build.status === 'succeeded'" :build="build" />
    <pre>{{ logText }}</pre>
    <div v-if="build.error" class="build-error-panel"><strong>错误摘要</strong><p>{{ build.error }}</p></div>
  </aside></div>
</template>
