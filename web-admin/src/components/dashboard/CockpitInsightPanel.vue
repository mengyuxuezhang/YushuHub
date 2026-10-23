<script setup lang="ts">
import { AlertTriangle, Bot, Boxes, CheckCircle2, Network, Radar } from '@lucide/vue'
import type { DashboardSummary } from '@/api/dashboard'

defineProps<{ summary: DashboardSummary | null; alerts: Array<{ tone: 'success' | 'warning' | 'danger'; title: string; detail: string }>; accountName: string; permissionCount: number }>()
</script>

<template>
  <article class="cockpit-panel cockpit-insight-panel">
    <header><div><span class="cockpit-kicker"><Radar :size="14" /> OPS RADAR</span><h2>运营雷达</h2></div><span class="radar-count">{{ alerts.length }}</span></header>
    <div class="cockpit-alerts"><div v-for="item in alerts" :key="item.title" :class="`is-${item.tone}`"><component :is="item.tone === 'success' ? CheckCircle2 : AlertTriangle" :size="17" /><span><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span></div></div>
    <div class="market-composition">
      <div class="cockpit-subtitle"><span>能力资产构成</span><small>共 {{ summary?.marketCount || 0 }} 项</small></div>
      <div class="market-track"><i class="agents" :style="{ flex: summary?.agentCount || 0 }"></i><i class="skills" :style="{ flex: summary?.skillCount || 0 }"></i><i class="mcps" :style="{ flex: summary?.mcpCount || 0 }"></i></div>
      <div class="market-legends"><span><Bot :size="14" /><b>{{ summary?.agentCount || 0 }}</b> 专家</span><span><Boxes :size="14" /><b>{{ summary?.skillCount || 0 }}</b> 技能</span><span><Network :size="14" /><b>{{ summary?.mcpCount || 0 }}</b> MCP</span></div>
    </div>
    <footer><span>当前数据视角</span><strong>{{ accountName }}</strong><small>{{ permissionCount }} 项权限 · 组织级安全隔离</small></footer>
  </article>
</template>
