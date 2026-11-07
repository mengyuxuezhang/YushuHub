<script setup lang="ts">
import { RefreshCw, Rocket } from '@lucide/vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import VersionHistoryPanel from '@/components/delivery/VersionHistoryPanel.vue'
import { useDeliverySystem } from '@/composables/delivery/useDeliverySystem'

defineProps<{ d: ReturnType<typeof useDeliverySystem> }>()
const taskLabels: Record<string, string> = {
  accepted: '任务已接收', pulling: '准备并校验版本', prepared: '备份完成', draining: '正在停止旧服务',
  stopped: '旧服务已停止', starting: '正在启动新版本', verifying: '正在验证运行状态',
  committed: '升级验证完成', rolling_back: '正在恢复原版本', rolled_back: '已恢复原版本',
  rejected: '升级未执行', needs_attention: '任务需要恢复处理', failed: '任务未完成',
}
</script>

<template>
  <div class="update-hero panel-card"><div><span>当前运行版本</span><strong>v{{ d.updateStatus.value.runningVersion || d.updateStatus.value.currentVersion || '-' }}</strong><p>{{ d.updateStatus.value.deploymentMode === 'docker' && d.updateStatus.value.versionMismatch ? '当前运行版本正在等待独立升级服务完成验证，请继续查看任务结果。' : d.updateStatus.value.versionMismatch ? `磁盘文件已是 v${d.updateStatus.value.diskVersion || '-'}，但运行进程尚未切换，请检查 PM2 重启状态。` : d.updateStatus.value.configured === false ? '尚未配置可信更新源' : d.updateStatus.value.updateAvailable ? `发现 v${d.updateStatus.value.latestVersion}，可查看版本说明后升级。` : '运行进程已是更新源提供的最新版本。' }}</p></div><StatusBadge :status="d.updateStatus.value.inProgress || d.updateStatus.value.versionMismatch || d.updateStatus.value.updateAvailable ? 'queued' : 'succeeded'" /></div>
  <section v-if="d.updateStatus.value.deploymentMode !== 'docker' && (d.updateStatus.value.versionMismatch || ['scheduled', 'restarting', 'failed'].includes(d.updateStatus.value.restartStatus?.state))" class="panel-card update-runtime-alert" :class="{ failed: d.updateStatus.value.restartStatus?.state === 'failed' }">
    <div><strong>{{ d.updateStatus.value.restartStatus?.state === 'failed' ? '升级重启验证失败' : '升级文件与运行进程尚未同步' }}</strong><p>运行版本 v{{ d.updateStatus.value.runningVersion || '-' }} · 磁盘版本 v{{ d.updateStatus.value.diskVersion || '-' }} · PM2 状态 {{ d.updateStatus.value.restartStatus?.state || '待重启' }}</p><small v-if="d.updateStatus.value.restartStatus?.error">{{ d.updateStatus.value.restartStatus.error }}</small></div>
    <button class="secondary-button" :disabled="d.saving.value" @click="d.checkUpdate"><RefreshCw :size="15" />重新检测</button>
  </section>
  <section v-if="d.updateStatus.value.deploymentMode === 'docker'" class="panel-card update-source-panel">
    <h2>独立升级任务</h2>
    <p aria-live="polite">{{ taskLabels[d.updateStatus.value.upgradeTask?.stage] || '尚未提交任务' }}</p>
    <p v-if="d.updateStatus.value.upgradeTask?.operationId">任务编号：{{ d.updateStatus.value.upgradeTask.operationId }}</p>
    <p v-if="d.updateStatus.value.connectionWarning" role="status">{{ d.updateStatus.value.connectionWarning }}</p>
    <p v-if="d.updateStatus.value.sourceWarning">{{ d.updateStatus.value.sourceWarning }}</p>
    <p>更新由独立升级服务执行，版本清单由管理员管理。切换期间页面可能暂时断开，将每五秒重新检测；持续不可用时，请使用独立部署工具查看任务和恢复服务。</p>
    <div class="update-action-row">
      <button v-if="d.updateStatus.value.upgradeTask?.stage === 'needs_attention'" class="secondary-button" :disabled="d.saving.value" @click="d.recoverUpdate('recover')">恢复中断任务</button>
      <button class="secondary-button" :disabled="d.saving.value || d.updateStatus.value.inProgress || d.updateStatus.value.upgradeTask?.stage === 'needs_attention'" @click="d.recoverUpdate('rollback')">回退上一个版本</button>
    </div>
  </section>
  <section v-else class="panel-card update-source-panel"><header><div><h2>更新源</h2><p>仅接受 HTTP/HTTPS 清单地址；保存只检查版本，不会自动升级。</p></div></header><div class="inline-update-form"><input v-model="d.form.manifestUrl" placeholder="https://example.com/admin/latest.json" /><button class="secondary-button" :disabled="d.saving.value" @click="d.saveUpdateSource">保存更新源</button></div></section>
  <div class="update-content-grid">
    <section class="panel-card"><h2>最新版本说明</h2><p class="release-notes">{{ d.updateStatus.value.releaseNotes || '暂无更新说明' }}</p><div class="update-action-row"><button class="secondary-button" :disabled="d.saving.value" @click="d.checkUpdate"><RefreshCw :size="15" />检测更新</button><button class="primary-button" :disabled="!d.updateStatus.value.updateAvailable || d.saving.value || d.updateStatus.value.inProgress || d.updateStatus.value.upgradeTask?.stage === 'needs_attention'" @click="d.applyUpdate"><Rocket :size="15" />立即升级</button></div></section>
    <section class="panel-card"><h2>最近检查日志</h2><pre>{{ d.updateStatus.value.lastLog || '暂无日志' }}</pre></section>
  </div>
  <VersionHistoryPanel title="管理后台历史更新" description="按月份回看管理后台的功能变化，快速查找每次更新。" :loading="d.loading.value" :current-version="d.updateStatus.value.runningVersion || d.updateStatus.value.currentVersion" :latest-version="d.updateStatus.value.latestVersion" :items="d.updateStatus.value.history || []" empty-text="当前更新清单暂未提供历史版本" />
</template>
