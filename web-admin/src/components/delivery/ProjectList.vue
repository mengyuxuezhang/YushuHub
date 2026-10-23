<script setup lang="ts">
import { CheckCircle2, LoaderCircle, Pencil, Play, Trash2 } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import BuildArtifactLinks from '@/components/delivery/BuildArtifactLinks.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { useDeliverySystem } from '@/composables/delivery/useDeliverySystem'
import { formatBuildTime, projectVersionState } from '@/utils/project-version'
import { buildExecutionLabel } from '@/utils/build-records'

const props = defineProps<{ d: ReturnType<typeof useDeliverySystem> }>()

function versionState(projectId: string) {
  return projectVersionState(props.d.latestBuildFor(projectId), props.d.sourceVersionInfo.value.version)
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
              <div class="project-version-cell" :class="versionState(project.id).stateClass">
                <span>上次构建 <b v-if="versionState(project.id).buildVersion">v{{ versionState(project.id).buildVersion }}</b><b v-else>—</b></span>
                <small>Agent 最新 v{{ versionState(project.id).latestVersion || '未获取' }} · {{ formatBuildTime(versionState(project.id).build?.updatedAt || versionState(project.id).build?.createdAt) }}</small>
              </div>
            </td>
            <td>
              <div v-if="d.activeBuildFor(project.id)" class="project-build-cell is-running">
                <LoaderCircle class="spin" :size="15" />
                <div><strong>{{ buildExecutionLabel(d.activeBuildFor(project.id)) }}</strong><small>{{ d.buildStage(d.activeBuildFor(project.id)) }}</small></div>
                <RouterLink to="/builds">查看进度</RouterLink>
              </div>
              <div v-else-if="d.latestBuildFor(project.id)?.status === 'succeeded'" class="project-build-cell is-done">
                <CheckCircle2 :size="15" />
                <div><strong>最近构建完成</strong><BuildArtifactLinks :build="d.latestBuildFor(project.id)" compact /></div>
                <RouterLink to="/builds">查看详情</RouterLink>
              </div>
              <div v-else-if="d.latestBuildFor(project.id)" class="project-build-cell is-idle">
                <div><strong>尚未构建</strong><small>{{ versionState(project.id).stateLabel }}</small></div>
              </div>
              <span v-else class="cell-note">尚未构建</span>
            </td>
            <td><StatusBadge :status="project.status" /></td>
            <td class="action-column">
              <div class="row-actions">
                <button class="text-button" @click="d.openProject(project)"><Pencil :size="14" />编辑</button>
                <button class="primary-button" :disabled="Boolean(d.activeBuildFor(project.id)) || d.isBuildSubmitting(project.id)" @click="d.startBuild(project)">
                  <LoaderCircle v-if="d.isBuildSubmitting(project.id)" class="spin" :size="14" />
                  <Play v-else :size="14" />{{ d.isBuildSubmitting(project.id) ? '提交中' : d.activeBuildFor(project.id) ? buildExecutionLabel(d.activeBuildFor(project.id)) : '测试构建' }}
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
