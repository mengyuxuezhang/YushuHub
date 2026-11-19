<script setup lang="ts">
import { computed } from 'vue'
import { Cpu, GitCommitHorizontal, PackageCheck } from '@lucide/vue'
import SearchToolbar from '@/components/common/SearchToolbar.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import VersionHistoryPanel from '@/components/delivery/VersionHistoryPanel.vue'
import { useDeliverySystem } from '@/composables/delivery/useDeliverySystem'
const props = defineProps<{ d: ReturnType<typeof useDeliverySystem> }>()
const platforms = computed(() => [
  { title: '桌面端', info: props.d.sourceVersionInfo.value },
  { title: 'Android', info: props.d.sourceVersionInfo.value.android || {} },
])
function versionsOutdated(worker: { versionMatchesSource?: boolean; androidVersionMatchesSource?: boolean }) {
  return worker.versionMatchesSource === false || worker.androidVersionMatchesSource === false
}
</script>

<template>
  <section v-for="{ title, info } in platforms" :key="title" class="agent-version-hero panel-card">
    <div class="entity-avatar agent-version-icon"><PackageCheck :size="24" /></div>
    <div><span>{{ title }}最新源码版本</span><strong class="metric-value">{{ info.version ? `v${info.version}` : d.loading.value ? '正在读取…' : '暂未获取' }}</strong><p>{{ info.releaseNotes || info.error || '等待官方构建中心提供源码版本。' }}</p></div>
    <dl><div><dt>发布时间</dt><dd>{{ info.publishedAt ? new Date(info.publishedAt).toLocaleString('zh-CN') : '未记录' }}</dd></div><div><dt><GitCommitHorizontal :size="13" />源码提交</dt><dd class="mono-text">{{ info.commit ? info.commit.slice(0, 12) : '未提供' }}</dd></div></dl>
  </section>
  <SearchToolbar
    v-model="d.search.value"
    v-model:field="d.searchField.value"
    :fields="[
      { value: 'all', label: '全部字段' },
      { value: 'worker', label: '构建机 / 主机名' },
      { value: 'platform', label: '平台' },
      { value: 'version', label: '客户端版本' },
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
  <div class="table-panel panel-card"><div v-if="d.loading.value && !d.filtered.value.length" class="table-loading">正在加载构建机…</div><div v-else-if="!d.filtered.value.length" class="empty-state"><Cpu :size="34" /><h2>暂无构建机心跳</h2><p>请检查 Worker Token、网络和构建机进程。</p></div><div v-else class="data-table-scroll"><table class="data-table worker-table"><thead><tr><th>构建机</th><th>连接状态</th><th>桌面端版本</th><th>Android 版本</th><th>当前任务</th><th>最后心跳</th></tr></thead><tbody>
    <tr v-for="worker in d.filtered.value" :key="worker.id"><td><div class="entity-cell"><span class="entity-avatar"><Cpu :size="18" /></span><div><strong>{{ worker.id }}</strong><span>{{ worker.metadata?.platform || '未上报平台' }}</span><small>{{ worker.metadata?.hostname || 'Worker 节点' }}</small></div></div></td><td><StatusBadge :status="worker.online ? (versionsOutdated(worker) ? 'queued' : 'online') : 'offline'" /><small class="cell-note">{{ worker.online ? (versionsOutdated(worker) ? '在线，版本待同步' : '在线可用') : '心跳中断' }}</small></td><td><span class="mono-text">{{ worker.metadata?.packageVersion ? `v${worker.metadata.packageVersion}` : '未上报' }}</span><small v-if="worker.expectedPackageVersion && worker.versionMatchesSource !== null" class="cell-note">期望 v{{ worker.expectedPackageVersion }}</small></td>
      <td><span class="mono-text">{{ worker.metadata?.androidVersion ? 'v' + worker.metadata.androidVersion : '未启用' }}</span><small v-if="worker.expectedAndroidVersion && worker.androidVersionMatchesSource !== null" class="cell-note">期望 v{{ worker.expectedAndroidVersion }}</small></td>
      <td><span v-if="worker.currentBuildId" class="soft-tag">构建中</span><span v-else class="cell-note">空闲</span><small v-if="worker.currentBuildId" class="mono-text compact">{{ worker.currentBuildId }}</small></td><td><span class="date-cell">{{ worker.lastSeenAt ? new Date(worker.lastSeenAt).toLocaleString('zh-CN') : '无心跳' }}</span></td></tr>
  </tbody></table></div></div>
  <VersionHistoryPanel v-for="{ title, info } in platforms" :key="title" :title="title + '更新记录'" :description="'查看 ' + title + ' 的源码版本与更新说明。'" :loading="d.loading.value" :latest-version="info.version" :items="info.history || []" />
</template>
