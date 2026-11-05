<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Copy } from '@lucide/vue'
import { writeClipboardText } from '@/utils/clipboard'

const props = defineProps<{ form: Record<string, any> }>()
const message = ref('')
const savedUrl = computed(() => {
  const value = String(props.form.latestDownloadUrl || '')
  try {
    const url = new URL(value)
    const expected = `/updates/ai/${encodeURIComponent(props.form.id)}/${encodeURIComponent(props.form.latestDownloadFileName || '')}`
    return ['http:', 'https:'].includes(url.protocol) && url.pathname.endsWith(expected) ? value : ''
  } catch { return '' }
})
watch(() => props.form.latestDownloadFileName, () => { message.value = '' })
async function copyLink() {
  try { await writeClipboardText(savedUrl.value); message.value = '链接已复制' }
  catch { message.value = '复制失败，请选择链接手动复制' }
}
</script>

<template>
  <section class="form-section" aria-label="固定下载链接">
    <div class="section-heading"><span>↓</span><div><h3>固定下载链接</h3><p>保存后生效，无需重新构建。始终下载最近一次成功推送给用户的 Windows x64 正式包，测试构建不会改变此链接。</p></div></div>
    <label><span>固定下载文件名</span><input v-model.trim="form.latestDownloadFileName" maxlength="128" :placeholder="`${form.id || 'brand'}-desktop-latest-x64.exe`" /><small>留空关闭。使用小写字母、数字、短横线或下划线，以 latest-x64.exe 结尾；修改名称后旧链接失效。</small></label>
    <template v-if="savedUrl">
      <label><span>固定下载地址</span><input :value="savedUrl" readonly aria-label="固定下载地址" /></label>
      <button type="button" class="secondary-button" @click="copyLink"><Copy :size="16" />复制下载链接</button>
      <small>尚未发布正式包时，链接会提示暂无可下载的正式版本。</small>
    </template>
    <p v-else-if="form.latestDownloadFileName" class="cell-note">保存项目后，重新打开可复制完整下载链接。</p>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>
