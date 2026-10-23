<script setup lang="ts">
import { Boxes, Cpu, Radio, ShieldCheck } from '@lucide/vue'

defineProps<{ score: number; label: string; sourceVersion: string; workerOnlineRate: number; buildSuccessRate: number }>()
</script>

<template>
  <article class="cockpit-panel cockpit-core-panel">
    <header><div><span class="cockpit-kicker"><Radio :size="14" /> SYSTEM CORE</span><h2>平台核心状态</h2></div><span class="core-signal"><i></i>实时监测</span></header>
    <div class="core-visual">
      <div class="core-radar"><i></i><i></i><i></i><span></span></div>
      <div class="health-ring" :style="{ '--health': `${score * 3.6}deg` }"><div><small>健康指数</small><strong>{{ score }}</strong><span>{{ label }}</span></div></div>
    </div>
    <div class="core-facts">
      <div><Cpu :size="17" /><span>节点在线率<strong>{{ workerOnlineRate }}%</strong></span></div>
      <div><Boxes :size="17" /><span>构建成功率<strong>{{ buildSuccessRate }}%</strong></span></div>
      <div><ShieldCheck :size="17" /><span>源码版本<strong>{{ sourceVersion }}</strong></span></div>
    </div>
  </article>
</template>
