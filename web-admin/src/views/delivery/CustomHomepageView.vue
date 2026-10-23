<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Archive, CodeXml, ExternalLink, Globe2, RefreshCw, RotateCcw, ShieldCheck, UploadCloud } from '@lucide/vue'

import * as homepageApi from '@/api/custom-homepage'
import { toUserMessage } from '@/api/client'
import { useFeedbackStore } from '@/stores/feedback'
import type { CustomHomepageStatus } from '@/types/custom-homepage'

const feedback = useFeedbackStore()
const status = ref<CustomHomepageStatus | null>(null)
const loading = ref(false)
const saving = ref(false)
const dragging = ref(false)
const html = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

const statusLabel = computed(() => status.value?.enabled ? '自定义首页已上线' : status.value?.configured ? '自定义首页已停用' : '正在使用官方首页')
const sizeLabel = computed(() => formatBytes(status.value?.totalBytes || 0))

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(value?: string) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

async function load(showSuccess = false) {
  loading.value = true
  try {
    status.value = await homepageApi.getCustomHomepage()
    if (showSuccess) feedback.notify('首页状态已刷新', 'success')
  } catch (error) {
    feedback.notify(toUserMessage(error), 'error')
  } finally {
    loading.value = false
  }
}

async function publishFile(file?: File) {
  if (!file || saving.value) return
  if (!/\.zip$/i.test(file.name)) {
    feedback.notify('请选择 ZIP 格式的完整站点压缩包', 'warning')
    return
  }
  saving.value = true
  try {
    status.value = await homepageApi.uploadCustomHomepage(file)
    feedback.notify('自定义首页已上传并上线', 'success')
  } catch (error) {
    feedback.notify(toUserMessage(error), 'error', 5200)
  } finally {
    saving.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

function handleDrop(event: DragEvent) {
  dragging.value = false
  void publishFile(event.dataTransfer?.files?.[0])
}

async function publishHtml() {
  if (!html.value.trim() || saving.value) {
    if (!html.value.trim()) feedback.notify('请先粘贴完整的 HTML 页面代码', 'warning')
    return
  }
  if (status.value?.configured) {
    const accepted = await feedback.confirm({
      title: '用单文件 HTML 替换当前站点？',
      message: '当前自定义站点及其图片、CSS、JS 文件会被替换，只保留这份 HTML。',
      confirmText: '确认替换',
      tone: 'danger',
    })
    if (!accepted) return
  }
  saving.value = true
  try {
    status.value = await homepageApi.saveCustomHomepageHtml(html.value)
    html.value = ''
    feedback.notify('单文件首页已保存并上线', 'success')
  } catch (error) {
    feedback.notify(toUserMessage(error), 'error', 5200)
  } finally {
    saving.value = false
  }
}

async function toggleEnabled() {
  if (!status.value || saving.value) return
  saving.value = true
  try {
    status.value = await homepageApi.setCustomHomepageEnabled(!status.value.enabled)
    feedback.notify(status.value.enabled ? '自定义首页已上线' : '已切换回官方首页，自定义文件仍然保留', 'success')
  } catch (error) {
    feedback.notify(toUserMessage(error), 'error')
  } finally {
    saving.value = false
  }
}

async function reset() {
  if (!status.value?.configured || saving.value) return
  const accepted = await feedback.confirm({
    title: '彻底删除自定义首页？',
    message: '将删除已上传的全部首页文件并恢复官方首页，此操作不可恢复。',
    confirmText: '删除并恢复官方首页',
    tone: 'danger',
  })
  if (!accepted) return
  saving.value = true
  try {
    status.value = await homepageApi.resetCustomHomepage()
    feedback.notify('自定义首页已删除，当前使用官方首页', 'success')
  } catch (error) {
    feedback.notify(toUserMessage(error), 'error')
  } finally {
    saving.value = false
  }
}

function preview() {
  if (status.value?.previewUrl) window.open(status.value.previewUrl, '_blank', 'noopener,noreferrer')
}

function visitHomepage() {
  window.open('/', '_blank', 'noopener,noreferrer')
}

onMounted(() => load())
</script>

<template>
  <section class="management-page custom-homepage-page">
    <header class="page-heading">
      <div><span class="eyebrow">Homepage studio</span><h1>首页装修</h1><p>发布完整静态站点，代理商自定义内容不会被管理端升级覆盖。</p></div>
      <div class="heading-actions">
        <button class="secondary-button" :disabled="loading" @click="load(true)"><RefreshCw :size="16" />刷新</button>
        <button class="secondary-button" @click="visitHomepage"><ExternalLink :size="16" />访问首页</button>
      </div>
    </header>

    <section class="homepage-status-card panel-card">
      <div class="homepage-status-icon" :class="{ active: status?.enabled }"><Globe2 :size="24" /></div>
      <div class="homepage-status-copy">
        <span class="eyebrow">Publishing status</span>
        <h2>{{ statusLabel }}</h2>
        <p v-if="status?.configured">来源：{{ status.sourceName }} · {{ status.fileCount }} 个文件 · {{ sizeLabel }} · 更新于 {{ formatTime(status.updatedAt) }}</p>
        <p v-else>上传站点后会立即启用；未配置时始终展示随版本更新的官方宣传页。</p>
      </div>
      <div class="homepage-status-actions">
        <button v-if="status?.configured" class="secondary-button" :disabled="saving" @click="preview"><ExternalLink :size="16" />预览</button>
        <button v-if="status?.configured" class="primary-button" :class="{ 'is-pause': status.enabled }" :disabled="saving" @click="toggleEnabled">{{ status.enabled ? '停用自定义首页' : '上线自定义首页' }}</button>
      </div>
    </section>

    <div class="homepage-editor-grid">
      <article class="panel-card homepage-editor-card">
        <header><span class="homepage-editor-icon"><Archive :size="20" /></span><div><h2>上传完整站点</h2><p>适合 AI 生成、多文件设计稿或已有企业官网。</p></div></header>
        <button
          class="homepage-dropzone"
          :class="{ dragging }"
          :disabled="saving"
          @click="fileInput?.click()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="handleDrop"
        >
          <UploadCloud :size="30" />
          <strong>{{ saving ? '正在发布…' : '点击选择或拖入 ZIP' }}</strong>
          <span>根目录需包含 index.html，也支持外层仅有一个项目目录</span>
          <small>ZIP ≤ 50 MB · 解压后 ≤ 200 MB · 最多 2,000 个文件</small>
        </button>
        <input ref="fileInput" class="homepage-file-input" type="file" accept=".zip,application/zip" @change="publishFile(($event.target as HTMLInputElement).files?.[0])" />
      </article>

      <article class="panel-card homepage-editor-card">
        <header><span class="homepage-editor-icon"><CodeXml :size="20" /></span><div><h2>粘贴单文件 HTML</h2><p>适合直接使用 AI 生成的单页代码，CSS 和 JS 可写在页面内。</p></div></header>
        <textarea v-model="html" spellcheck="false" placeholder="<!doctype html>&#10;<html>...完整页面代码...</html>"></textarea>
        <footer><span>保存后会替换现有自定义站点</span><button class="primary-button" :disabled="saving || !html.trim()" @click="publishHtml"><CodeXml :size="16" />保存并上线</button></footer>
      </article>
    </div>

    <section class="homepage-safety-note panel-card">
      <ShieldCheck :size="22" />
      <div><h2>自由设计，隔离后台权限</h2><p>页面可运行自己的 HTML、CSS、JavaScript、字体、图片、视频和外部链接；浏览器会将它与管理后台登录态隔离，页面代码不能读取后台 Cookie 或直接调用敏感管理接口。</p></div>
    </section>

    <section v-if="status?.configured" class="homepage-danger-zone panel-card">
      <div><h2>恢复官方首页</h2><p>仅停用不会删除文件；如需释放空间并彻底恢复默认状态，可删除全部自定义站点文件。</p></div>
      <button class="secondary-button danger-button" :disabled="saving" @click="reset"><RotateCcw :size="16" />删除自定义站点</button>
    </section>
  </section>
</template>
