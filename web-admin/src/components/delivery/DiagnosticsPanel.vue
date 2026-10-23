<script setup lang="ts">
import { Download, Wrench } from '@lucide/vue'
import { useDeliverySystem } from '@/composables/delivery/useDeliverySystem'

defineProps<{ d: ReturnType<typeof useDeliverySystem> }>()
</script>

<template>
  <div class="diagnostic-toolbar"><p>导出的日志包含运行环境、关键访问地址、最近构建和服务日志，可直接用于问题排查。</p><button class="secondary-button" @click="d.exportDiagnostics"><Download :size="16" />导出诊断日志</button></div>
  <div class="diagnostic-summary-grid">
    <article class="panel-card"><span>管理端版本</span><strong>{{ d.diagnostics.value.version || '-' }}</strong><small>{{ d.diagnostics.value.generatedAt ? new Date(d.diagnostics.value.generatedAt).toLocaleString('zh-CN') : '等待诊断' }}</small></article>
    <article class="panel-card"><span>运行环境</span><strong>{{ d.diagnostics.value.node || '-' }}</strong><small>{{ d.diagnostics.value.pm2Name || '未提供进程名' }}</small></article>
    <article class="panel-card"><span>正式更新项目</span><strong>{{ d.diagnostics.value.updateCheckUrls?.length || 0 }}</strong><small>仅统计已有正式更新地址的项目</small></article>
    <article class="panel-card"><span>最近构建</span><strong>{{ d.diagnostics.value.recentBuilds?.length || 0 }}</strong><small>用于快速判断构建链路活跃度</small></article>
  </div>
  <section class="panel-card endpoint-panel"><header><Wrench :size="18" /><div><h2>关键访问地址</h2><p>复制下列地址可从服务器外部验证注册与更新链路。</p></div></header><dl>
    <div><dt>后台 API</dt><dd>{{ d.diagnostics.value.apiCheckUrl || '未配置' }}</dd></div>
    <div><dt>客户端注册</dt><dd>{{ d.diagnostics.value.clientRegisterUrl || '未配置' }}</dd></div>
    <div><dt>更新地址模板</dt><dd>{{ d.diagnostics.value.updateCheckExampleUrl || '未配置' }}</dd></div>
    <div v-for="item in d.diagnostics.value.updateCheckUrls || []" :key="item.projectId"><dt>项目 {{ item.projectId }}</dt><dd>{{ item.latestUrl }}</dd></div>
  </dl></section>
</template>
