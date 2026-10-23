<script setup lang="ts">
import { FileText, RotateCw, Square, UploadCloud } from '@lucide/vue'
import BuildArtifactLinks from '@/components/delivery/BuildArtifactLinks.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { useDeliverySystem } from '@/composables/delivery/useDeliverySystem'
import { buildExecutionLabel, buildReleaseLabel } from '@/utils/build-records'
defineProps<{ d: ReturnType<typeof useDeliverySystem> }>()
</script>

<template>
  <div class="table-panel panel-card build-table-panel">
    <div v-if="d.loading.value && !d.filtered.value.length" class="table-loading">正在加载构建任务…</div>
    <div v-else-if="!d.filtered.value.length" class="empty-state"><FileText :size="34" /><h2>暂无构建任务</h2><p>从 AI 项目提交测试构建后，任务和日志会显示在这里。</p></div>
    <div v-else class="data-table-scroll"><table class="data-table build-table"><thead><tr><th>项目 / 任务</th><th>版本</th><th>构建状态</th><th>构建来源</th><th>测试 / 正式包</th><th>更新时间</th><th class="action-column">操作</th></tr></thead><tbody>
      <tr v-for="build in d.filtered.value" :key="build.id">
        <td><div class="entity-cell"><span class="entity-avatar"><FileText :size="18" /></span><div><strong :title="build.projectName || build.projectId">{{ build.projectName || build.projectId }}</strong><small class="cell-note mono-text compact" :title="build.id">{{ build.id }}</small></div></div></td>
        <td><span class="mono-text compact">{{ build.version ? `v${build.version}` : '等待分配' }}</span></td>
        <td class="build-status-cell"><StatusBadge :status="build.status" :label="buildExecutionLabel(build)" /><span v-if="buildReleaseLabel(build)" class="build-release-label" :class="{ 'is-failed': build.releaseStatus === 'failed' }">{{ buildReleaseLabel(build) }}</span><div v-if="['queued','running'].includes(build.status)" class="compact-progress"><i :style="{ width: `${d.buildPercent(build)}%` }"></i></div><small v-if="d.buildStage(build)" class="cell-note build-status-detail" :title="d.buildStage(build)">{{ d.buildStage(build) }}</small><small v-if="build.error" class="cell-note cell-error build-status-detail" :title="build.error">{{ build.error }}</small></td>
        <td><strong>{{ build.delegatedToCenter ? '官方构建中心' : '本地 Worker' }}</strong><small v-if="build.claimedBy" class="cell-note" :title="build.claimedBy">{{ build.claimedBy }}</small></td>
        <td><BuildArtifactLinks v-if="build.status === 'succeeded'" :build="build" compact /><span v-else class="cell-note">构建完成后显示</span></td>
        <td><span class="date-cell">{{ new Date(build.updatedAt || build.createdAt).toLocaleString('zh-CN') }}</span></td>
        <td class="action-column"><div class="row-actions"><button class="text-button" @click="d.openBuildLog(build)"><FileText :size="14" />日志</button><button v-if="build.status === 'failed' && build.canOperate !== false" class="text-button" @click="d.buildAction(build, 'retry')"><RotateCw :size="14" />重试</button><button v-if="['queued','running'].includes(build.status) && build.canOperate !== false" class="text-button danger" @click="d.buildAction(build, 'finish')"><Square :size="13" />结束</button><button v-if="build.status === 'succeeded' && !build.releasedAt && build.releaseStatus !== 'publishing' && build.canOperate !== false" class="text-button danger" @click="d.buildAction(build, 'publish')"><UploadCloud :size="14" />{{ build.releaseStatus === 'failed' ? '重新推送' : '推送' }}</button><span v-if="build.canOperate === false" class="cell-note">只读</span></div></td>
      </tr>
    </tbody></table></div>
  </div>
</template>
