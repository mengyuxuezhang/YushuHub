<script setup lang="ts">
import { ArrowUpRight, GitBranch, TimerReset } from '@lucide/vue'
import type { DashboardSummary } from '@/api/dashboard'

const props = defineProps<{ summary: DashboardSummary | null }>()
const statusNames: Record<string, string> = { queued: '排队中', running: '构建中', publishing: '发布中', success: '已完成', succeeded: '已完成', published: '已发布', completed: '已完成', failed: '失败', error: '异常', cancelled: '已取消', canceled: '已取消' }
function statusTone(status: string) { return ['failed', 'error', 'cancelled', 'canceled'].includes(status) ? 'danger' : ['queued', 'running', 'publishing'].includes(status) ? 'warning' : 'success' }
function proportion(value: number | null | undefined) { return props.summary?.buildCount ? Math.max(4, Math.round(((value || 0) / props.summary.buildCount) * 100)) : 0 }
</script>

<template>
  <article class="cockpit-panel cockpit-build-panel">
    <header><div><span class="cockpit-kicker"><GitBranch :size="14" /> DELIVERY FLOW</span><h2>构建交付态势</h2></div><RouterLink to="/builds" class="cockpit-link">查看构建中心 <ArrowUpRight :size="15" /></RouterLink></header>
    <div class="build-flow-bars">
      <div><span><b>成功交付</b><em>{{ summary?.succeededBuildCount || 0 }}</em></span><i><b class="is-success" :style="{ width: `${proportion(summary?.succeededBuildCount)}%` }"></b></i></div>
      <div><span><b>正在处理</b><em>{{ summary?.runningBuildCount || 0 }}</em></span><i><b class="is-running" :style="{ width: `${proportion(summary?.runningBuildCount)}%` }"></b></i></div>
      <div><span><b>异常任务</b><em>{{ summary?.failedBuildCount || 0 }}</em></span><i><b class="is-failed" :style="{ width: `${proportion(summary?.failedBuildCount)}%` }"></b></i></div>
    </div>
    <div class="recent-builds">
      <div class="cockpit-subtitle"><span><TimerReset :size="15" />最近构建</span><small>按最后更新时间</small></div>
      <article v-for="item in summary?.recentBuilds || []" :key="item.id"><i :class="`is-${statusTone(item.status)}`"></i><div><strong>{{ item.name }}</strong><span>{{ item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : item.id }}</span></div><em :class="`is-${statusTone(item.status)}`">{{ statusNames[item.status] || item.status }}</em></article>
      <div v-if="!summary?.recentBuilds.length" class="cockpit-empty">暂无可展示的构建任务</div>
    </div>
  </article>
</template>
