<script setup lang="ts">
import type { BuildTarget } from '@/api/delivery-system'
import { CheckCircle2, LoaderCircle, Pencil, Play, Trash2 } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import BuildArtifactLinks from '@/components/delivery/BuildArtifactLinks.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { useDeliverySystem } from '@/composables/delivery/useDeliverySystem'
import { formatBuildTime, projectVersionState } from '@/utils/project-version'
import { buildExecutionLabel } from '@/utils/build-records'

const props = defineProps<{ d: ReturnType<typeof useDeliverySystem> }>()

const platforms = [{ target: 'desktop', label: '桌面端' }, { target: 'android', label: 'Android' }] as const
function versionState(projectId: string, target: BuildTarget) {
  const source = props.d.sourceVersionInfo.value
  const build = props.d.latestBuildFor(projectId, target)
  if (target === 'android' && build?.target !== 'android') {
    return projectVersionState(build ? { ...build, version: build.androidRelease?.version || '' } : null, source.android?.version)
  }
  return projectVersionState(build, target === 'android' ? source.android?.version : source.version)
}
</script>

<template>
  <div class="table-panel panel-card project-table-panel">
    <div v-if="d.loading.value && !d.filtered.value.length" class="table-loading">正在加载 AI 项目…</div>
    <div v-else-if="!d.filtered.value.length" class="empty-state"><h2>暂无 AI 项目</h2><p>创建项目后配置品牌、客户端菜单并提交测试构建。</p></div>
    <div v-else class="data-table-scroll">
      <table class="data-table project-table">
        <thead>
          <tr>
            <th>AI 项目</th>
            <th>版本</th>
            <th>构建状态</th>
            <th>项目状态</th>
            <th class="action-column">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="project in d.filtered.value" :key="project.id">
            <td>
              <div class="entity-cell">
                <span class="entity-avatar">{{ (project.shortName || project.appName || 'AI').slice(0, 2) }}</span>
                <div>
                  <strong>{{ project.brandName || project.appName }}</strong>
                  <span>{{ project.id }}</span>
                </div>
              </div>
            </td>
            <td>
              <div v-for="platform in platforms" :key="platform.target" class="project-version-cell" :class="versionState(project.id, platform.target).stateClass">
                <span>{{ platform.label }}上次构建 <b v-if="versionState(project.id, platform.target).buildVersion">v{{ versionState(project.id, platform.target).buildVersion }}</b><b v-else>—</b></span>
                <small>最新 v{{ versionState(project.id, platform.target).latestVersion || '未获取' }} · {{ formatBuildTime(versionState(project.id, platform.target).build?.updatedAt || versionState(project.id, platform.target).build?.createdAt) }}</small>
              </div>
            </td>
            <td>
              <template v-for="platform in platforms" :key="platform.target">
              <div v-if="d.activeBuildFor(project.id, platform.target)" class="project-build-cell is-running">
                <LoaderCircle class="spin" :size="15" />
                <div><strong>{{ platform.label }} · {{ buildExecutionLabel(d.activeBuildFor(project.id, platform.target)) }}</strong><small>{{ d.buildStage(d.activeBuildFor(project.id, platform.target)) }}</small></div>
                <RouterLink to="/builds">查看进度</RouterLink>
              </div>
              <div v-else-if="d.latestBuildFor(project.id, platform.target)?.status === 'succeeded'" class="project-build-cell is-done">
                <CheckCircle2 :size="15" />
                <div><strong>{{ platform.label }} · 最近构建完成</strong><BuildArtifactLinks :build="d.latestBuildFor(project.id, platform.target)" :target="platform.target" compact /></div>
                <RouterLink to="/builds">查看详情</RouterLink>
              </div>
              <div v-else-if="d.latestBuildFor(project.id, platform.target)" class="project-build-cell is-idle">
                <div><strong>{{ platform.label }} · {{ buildExecutionLabel(d.latestBuildFor(project.id, platform.target)) }}</strong><small>{{ versionState(project.id, platform.target).stateLabel }}</small></div>
              </div>
              <div v-else class="cell-note">{{ platform.label }} · 尚未构建</div>
              </template>
            </td>
            <td><StatusBadge :status="project.status" /></td>
            <td class="action-column">
              <div class="row-actions">
                <button class="text-button" @click="d.openProject(project)"><Pencil :size="14" />编辑</button>
                <button v-for="platform in platforms" :key="platform.target" class="primary-button" :disabled="!d.canBuild(platform.target) || Boolean(d.activeBuildFor(project.id, platform.target)) || d.isBuildSubmitting(project.id, platform.target)" @click="d.startBuild(project, platform.target)">
                  <LoaderCircle v-if="d.isBuildSubmitting(project.id, platform.target)" class="spin" :size="14" />
                  <Play v-else :size="14" />{{ d.isBuildSubmitting(project.id, platform.target) ? '提交中' : d.activeBuildFor(project.id, platform.target) ? buildExecutionLabel(d.activeBuildFor(project.id, platform.target)) : (platform.target === 'desktop' ? '测试构建桌面端' : '测试构建 Android') }}
                </button>
                <button class="icon-danger" title="删除项目" @click="d.removeProject(project)"><Trash2 :size="16" /></button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
