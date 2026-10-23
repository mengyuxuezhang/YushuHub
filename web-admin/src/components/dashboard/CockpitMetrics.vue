<script setup lang="ts">
import { Bot, Boxes, Cpu, FolderKanban } from '@lucide/vue'
import type { DashboardSummary } from '@/api/dashboard'

defineProps<{ summary: DashboardSummary | null; loading: boolean; buildSuccessRate: number; workerOnlineRate: number }>()
</script>

<template>
  <section class="cockpit-metrics" aria-label="核心运营指标">
    <article class="cockpit-metric is-blue"><div class="metric-orbit"><FolderKanban :size="21" /></div><span>AI 项目总量</span><strong :class="{ skeleton: loading && !summary }">{{ summary?.projectCount ?? '—' }}</strong><div class="cockpit-meter"><i :style="{ width: summary?.projectCount ? '100%' : '0%' }"></i></div><small>当前权限范围内项目资产</small></article>
    <article class="cockpit-metric is-purple"><div class="metric-orbit"><Boxes :size="21" /></div><span>构建任务</span><strong :class="{ skeleton: loading && !summary }">{{ summary?.buildCount ?? '—' }}</strong><div class="metric-inline"><b>{{ summary?.runningBuildCount || 0 }}</b> 个处理中 <em>成功率 {{ buildSuccessRate }}%</em></div><small>构建、发布与交付任务</small></article>
    <article class="cockpit-metric is-cyan"><div class="metric-orbit"><Cpu :size="21" /></div><span>在线构建机</span><strong :class="{ skeleton: loading && !summary }">{{ summary?.workerOnlineCount ?? '—' }}<i>/ {{ summary?.workerTotalCount ?? '—' }}</i></strong><div class="cockpit-meter"><i :style="{ width: `${workerOnlineRate}%` }"></i></div><small>在线率 {{ workerOnlineRate }}% · 源码 {{ summary?.sourceVersion || '读取中' }}</small></article>
    <article class="cockpit-metric is-green"><div class="metric-orbit"><Bot :size="21" /></div><span>能力资产</span><strong :class="{ skeleton: loading && !summary }">{{ summary?.marketCount ?? '—' }}</strong><div class="metric-inline"><b>{{ summary?.agentCount || 0 }}</b> 专家 <em>{{ (summary?.skillCount || 0) + (summary?.mcpCount || 0) }} 项扩展</em></div><small>专家、技能与 MCP 资产</small></article>
  </section>
</template>
