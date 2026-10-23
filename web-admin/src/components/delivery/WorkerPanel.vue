<script setup lang="ts">
import { Cpu, GitCommitHorizontal, PackageCheck } from '@lucide/vue'
import SearchToolbar from '@/components/common/SearchToolbar.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import VersionHistoryPanel from '@/components/delivery/VersionHistoryPanel.vue'
import { useDeliverySystem } from '@/composables/delivery/useDeliverySystem'
defineProps<{ d: ReturnType<typeof useDeliverySystem> }>()
</script>

<template>
  <section class="agent-version-hero panel-card">
    <div class="agent-version-icon"><PackageCheck :size="24" /></div>
    <div><span>Agent 客户端最新版本</span><strong>{{ d.sourceVersionInfo.value.version ? `v${d.sourceVersionInfo.value.version}` : d.loading.value ? '正在读取…' : '暂未获取' }}</strong><p>{{ d.sourceVersionInfo.value.releaseNotes || d.sourceVersionInfo.value.error || '从官方构建中心读取可用于构建的 Agent 客户端源码版本。' }}</p></div>
    <dl><div><dt>发布时间</dt><dd>{{ d.sourceVersionInfo.value.publishedAt ? new Date(d.sourceVersionInfo.value.publishedAt).toLocaleString('zh-CN') : '未记录' }}</dd></div><div><dt><GitCommitHorizontal :size="13" />源码提交</dt><dd class="mono-text">{{ d.sourceVersionInfo.value.commit ? d.sourceVersionInfo.value.commit.slice(0, 12) : '未提供' }}</dd></div></dl>
  </section>
  <SearchToolbar
    v-model="d.search.value"
    v-model:field="d.searchField.value"
    :fields="[
      { value: 'all', label: '全部字段' },
      { value: 'worker', label: '构建机 / 主机名' },
      { value: 'platform', label: '平台' },
      { value: 'version', label: 'Desktop 版本' },
      { value: 'build', label: '当前任务 ID' },
    ]"
    :loading="d.loading.value"
    placeholder="请输入构建机搜索关键词"
    :result-text="`在线 ${d.filtered.value.filter(worker => worker.online).length} / 共 ${d.filtered.value.length} 台`"
    @search="d.submitSearch"
    @reset="d.resetSearch"
  >
    <select v-model="d.statusFilter.value" aria-label="构建机状态"><option value="all">全部状态</option><option value="online">在线</option><option value="offline">离线</option><option value="outdated">版本待同步</option></select>
  </SearchToolbar>
  <div class="table-panel panel-card"><div v-if="d.loading.value && !d.filtered.value.length" class="table-loading">正在加载构建机…</div><div v-else-if="!d.filtered.value.length" class="empty-state"><Cpu :size="34" /><h2>暂无构建机心跳</h2><p>请检查 Worker Token、网络和构建机进程。</p></div><div v-else class="data-table-scroll"><table class="data-table worker-table"><thead><tr><th>构建机</th><th>连接状态</th><th>Desktop 版本</th><th>当前任务</th><th>最后心跳</th></tr></thead><tbody>
    <tr v-for="worker in d.filtered.value" :key="worker.id"><td><div class="entity-cell"><span class="entity-avatar"><Cpu :size="18" /></span><div><strong>{{ worker.id }}</strong><span>{{ worker.metadata?.platform || '未上报平台' }}</span><small>{{ worker.metadata?.hostname || 'Worker 节点' }}</small></div></div></td><td><StatusBadge :status="worker.online ? (worker.versionMatchesSource === false ? 'queued' : 'online') : 'offline'" /><small class="cell-note">{{ worker.online ? (worker.versionMatchesSource === false ? '在线，版本待同步' : '在线可用') : '心跳中断' }}</small></td><td><span class="mono-text">{{ worker.metadata?.packageVersion ? `v${worker.metadata.packageVersion}` : '未上报' }}</span><small v-if="worker.expectedPackageVersion" class="cell-note">期望 v{{ worker.expectedPackageVersion }}</small></td><td><span v-if="worker.currentBuildId" class="soft-tag">构建中</span><span v-else class="cell-note">空闲</span><small v-if="worker.currentBuildId" class="mono-text compact">{{ worker.currentBuildId }}</small></td><td><span class="date-cell">{{ worker.lastSeenAt ? new Date(worker.lastSeenAt).toLocaleString('zh-CN') : '无心跳' }}</span></td></tr>
  </tbody></table></div></div>
  <p class="diagnostic-note">当前仅保留 desktop-qrjhkol-02 和 local-windows-v3；其他历史构建机不再显示，也不参与心跳状态统计。</p>
  <VersionHistoryPanel title="Agent 版本更新记录" description="显示官方构建中心最近发布的 50 个 Agent 客户端版本及更新内容。" :latest-version="d.sourceVersionInfo.value.version" :items="d.sourceVersionInfo.value.history || []" :empty-text="d.loading.value ? '正在读取 Agent 历史版本…' : '官方更新源暂未提供 Agent 历史版本'" />
</template>
