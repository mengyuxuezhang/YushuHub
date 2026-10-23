<script setup lang="ts">
import CockpitBuildPanel from '@/components/dashboard/CockpitBuildPanel.vue'
import CockpitCoreStatus from '@/components/dashboard/CockpitCoreStatus.vue'
import CockpitHeader from '@/components/dashboard/CockpitHeader.vue'
import CockpitInsightPanel from '@/components/dashboard/CockpitInsightPanel.vue'
import CockpitMetrics from '@/components/dashboard/CockpitMetrics.vue'
import { useDashboardCockpit } from '@/composables/dashboard/useDashboardCockpit'

const d = useDashboardCockpit()
</script>

<template>
  <section class="cockpit-page">
    <div class="cockpit-grid-lines"></div>
    <CockpitHeader :clock="d.clock.value" :loaded-at="d.summary.value?.loadedAt" :loading="d.loading.value" :organization="d.auth.user?.organizationName || d.auth.user?.displayName || d.auth.user?.username || '当前组织'" @refresh="d.loadSummary(true)" />
    <CockpitMetrics :summary="d.summary.value" :loading="d.loading.value" :build-success-rate="d.buildSuccessRate.value" :worker-online-rate="d.workerOnlineRate.value" />
    <section class="cockpit-main-grid">
      <CockpitBuildPanel :summary="d.summary.value" />
      <CockpitCoreStatus :score="d.healthScore.value" :label="d.healthLabel.value" :source-version="d.summary.value?.sourceVersion || '读取中'" :worker-online-rate="d.workerOnlineRate.value" :build-success-rate="d.buildSuccessRate.value" />
      <CockpitInsightPanel :summary="d.summary.value" :alerts="d.alerts.value" :account-name="d.auth.user?.organizationName || d.auth.user?.displayName || d.auth.user?.username || '当前账号'" :permission-count="d.auth.user?.permissionKeys.length || 0" />
    </section>
    <footer class="cockpit-footer"><span><i></i>平台监测在线</span><span>数据更新时间：{{ d.summary.value?.loadedAt ? new Date(d.summary.value.loadedAt).toLocaleString('zh-CN') : '正在同步' }}</span><span>指标仅包含当前账号可见数据</span></footer>
  </section>
</template>
