<script setup lang="ts">
import { Download } from '@lucide/vue'

const props = defineProps<{
  downloadUrl: string
  config: { schema: 'agent-mobile-build-v1'; projectId: string; appName: string; clientApiUrl: string; themeColor: string } | null
}>()

defineEmits<{ 'update:downloadUrl': [value: string] }>()

function download() {
  if (!props.config) return
  const data = new Blob([JSON.stringify(props.config, null, 2) + '\n'], { type: 'application/json' })
  const url = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url
  link.download = `${props.config.projectId}-android-build.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <section class="form-section" aria-label="Android 手机端">
    <div class="section-heading"><span>↓</span><div><h3>Android 手机端</h3><p>设置桌面端「手机端」入口的扫码下载地址。</p></div></div>
    <label><span>Android 下载页地址</span><input :value="downloadUrl" type="url" maxlength="300" placeholder="https://…" @input="$emit('update:downloadUrl', ($event.target as HTMLInputElement).value)" /><small>填写提供 APK 和对应源码的 HTTPS 下载页。保存后，支持此入口的桌面端下次打开时自动更新，留空暂停下载。</small></label>
    <details>
      <summary>构建机工具</summary>
      <p class="cell-note">签名构建使用已保存的项目 ID、品牌名称、颜色和 API 地址。</p>
      <button v-if="config" type="button" class="secondary-button" @click="download"><Download :size="16" />导出 Android 构建配置</button>
      <p v-else class="cell-note">保存并启用项目后，使用 HTTPS 管理地址重新打开配置。</p>
    </details>
  </section>
</template>
