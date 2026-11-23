<script setup lang="ts">
import { Download, ExternalLink, PackageCheck } from '@lucide/vue'
import { computed } from 'vue'
import type { BuildTarget } from '@/api/delivery-system'
import { androidTestArtifacts, buildArtifactLinks, buildFileUrl, buildPublicUrl, isAndroidTestArtifact, primaryBuildArtifact } from '@/utils/build-artifacts'

const props = withDefaults(defineProps<{ build: any; compact?: boolean; target?: BuildTarget }>(), { compact: false })
const activeTarget = computed(() => props.target || props.build?.target)
const testUrl = computed(() => buildPublicUrl(props.build?.publicUrl))
const releaseUrl = computed(() => buildPublicUrl(props.build?.releaseUrl))
const desktop = computed(() => ({ ...props.build, files: Array.isArray(props.build?.files) ? props.build.files.filter((name: unknown) => typeof name === 'string' && !isAndroidTestArtifact(name)) : [] }))
const testLinks = computed(() => buildArtifactLinks(desktop.value, testUrl.value))
const releaseLinks = computed(() => buildArtifactLinks(desktop.value, releaseUrl.value))
const testPrimary = computed(() => primaryBuildArtifact(desktop.value, testUrl.value))
const releasePrimary = computed(() => primaryBuildArtifact(desktop.value, releaseUrl.value))
const android = computed(() => androidTestArtifacts(props.build))
const androidRelease = computed(() => buildFileUrl(props.build?.androidRelease?.url, 'android-arm64.apk'))
const androidSource = computed(() => {
  const release = props.build?.androidRelease
  if (!release?.url) return ''
  if (!release.sourceRevision) return buildFileUrl(release.url, 'android-source.zip')
  const { projectId, id } = props.build
  return projectId && id ? `/api/client/android-download/${encodeURIComponent(projectId)}/source/${encodeURIComponent(id)}` : ''
})
</script>

<template>
  <div v-if="compact && activeTarget !== 'android'" class="artifact-links-compact">
    <a v-if="testPrimary" class="artifact-download-primary" :href="testPrimary.url" target="_blank" rel="noopener"><Download :size="14" />桌面测试包</a>
    <a v-else-if="testUrl" class="artifact-download-primary" :href="testUrl" target="_blank" rel="noopener"><ExternalLink :size="14" />打开测试产物</a>
    <span v-else class="artifact-unavailable">地址待同步</span>
    <a v-if="releasePrimary" class="artifact-download-primary is-release" :href="releasePrimary.url" target="_blank" rel="noopener"><PackageCheck :size="14" />桌面正式包</a>
    <span v-else-if="build.releaseStatus === 'publishing'" class="artifact-release-state">正式包推送中</span>
    <span v-else-if="build.releaseStatus === 'failed'" class="artifact-release-state is-failed">正式包推送失败</span>
    <small v-if="testLinks.length">测试通道共 {{ testLinks.length }} 个文件</small>
  </div>
  <template v-else-if="activeTarget !== 'android'">
    <section v-if="testUrl" class="build-artifacts-panel">
      <header><div><PackageCheck :size="19" /><div><strong>测试包下载</strong><span>请先安装测试，确认无误后再推送给用户。</span></div></div><a :href="testUrl" target="_blank" rel="noopener"><ExternalLink :size="14" />打开测试产物目录</a></header>
      <div class="artifact-public-url"><code :title="testUrl">{{ testUrl }}</code></div>
      <div v-if="testLinks.length" class="artifact-file-list"><a v-for="item in testLinks" :key="item.name" :class="{ primary: item.primary }" :href="item.url" target="_blank" rel="noopener"><Download :size="15" /><span><strong>{{ item.primary ? '下载测试安装包' : item.name }}</strong><small v-if="item.primary">{{ item.name }}</small></span></a></div>
      <p v-else class="artifact-empty-note">构建服务已返回测试产物目录，但没有文件清单，可先打开目录查看。</p>
    </section>
    <section v-else class="build-artifacts-panel artifact-missing"><strong>测试包地址尚未同步</strong><span>请点击刷新；如果仍未出现，请检查产物上传日志。</span></section>
    <section v-if="releaseUrl" class="build-artifacts-panel is-release">
      <header><div><PackageCheck :size="19" /><div><strong>正式包下载</strong><span>该版本已推送到客户端正式更新通道。</span></div></div><a :href="releaseUrl" target="_blank" rel="noopener"><ExternalLink :size="14" />打开正式产物目录</a></header>
      <div class="artifact-public-url"><code :title="releaseUrl">{{ releaseUrl }}</code></div>
      <div v-if="releaseLinks.length" class="artifact-file-list"><a v-for="item in releaseLinks" :key="item.name" :class="{ primary: item.primary }" :href="item.url" target="_blank" rel="noopener"><Download :size="15" /><span><strong>{{ item.primary ? '下载正式安装包' : item.name }}</strong><small v-if="item.primary">{{ item.name }}</small></span></a></div>
    </section>
    <section v-else-if="build.releaseStatus === 'publishing'" class="build-artifacts-panel release-pending"><strong>正式包正在推送</strong><span>完成后这里会显示正式更新地址，请稍后刷新。</span></section>
    <section v-else-if="build.releaseStatus === 'failed'" class="build-artifacts-panel artifact-missing"><strong>正式包推送失败</strong><span>{{ build.releaseError || '请查看日志并重新推送。' }}</span></section>
  </template>
  <div v-if="activeTarget !== 'desktop' && (android || build.androidBuildError || build.androidRelease)" class="artifact-links-compact">
    <a v-if="android?.apk" class="artifact-download-primary" :href="android.apk" target="_blank" rel="noopener"><Download :size="14" />Android 测试包</a>
    <a v-if="!compact && android?.source" :href="android.source" target="_blank" rel="noopener">Android 测试包对应源码</a>
    <a v-if="!compact && android?.brand" :href="android.brand" target="_blank" rel="noopener">Android 测试包品牌配置与图标</a>
    <a v-if="androidRelease" class="artifact-download-primary is-release" :href="androidRelease" target="_blank" rel="noopener"><PackageCheck :size="14" />Android 正式包</a>
    <a v-if="!compact && androidSource" :href="androidSource" target="_blank" rel="noopener">Android 正式包对应源码与许可</a>
    <span v-if="build.androidRelease?.status === 'publishing'" class="artifact-release-state">Android 推送中</span>
    <span v-if="build.androidRelease?.status === 'failed'" class="artifact-release-state is-failed">{{ build.androidRelease.error }}</span>
    <span v-if="build.androidBuildError" class="artifact-release-state is-failed" :title="build.androidBuildError">Android 构建失败</span>
  </div>
</template>
