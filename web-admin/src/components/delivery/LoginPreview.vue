<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { loginDesigns, loginPreviewDocument } from '@/utils/login-preview'
const props = defineProps<{ form: Record<string, any> }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const size = ref('desktop')
const source = computed(() => loginPreviewDocument(props.form, window.location.href))
onMounted(() => dialog.value?.showModal())
</script>

<template>
  <dialog ref="dialog" class="login-preview-dialog" aria-label="登录页预览" @cancel.prevent="emit('close')">
    <header><div><h2>登录页预览</h2><p>当前未保存内容 · 仅展示效果，不会提交登录或创建构建</p></div><button class="secondary-button" autofocus @click="emit('close')">关闭预览</button></header>
    <nav aria-label="预览设置">
      <label>设计方案 <select v-model="form.loginDesign"><option v-for="design in loginDesigns" :key="design.id" :value="design.id">{{ design.name }}</option></select></label>
      <label>窗口尺寸 <select v-model="size"><option value="desktop">桌面窗口 · 1200 × 800</option><option value="compact">紧凑窗口 · 680 × 560</option></select></label>
      <span>切换方案会同步到当前草稿；保存后才生效。</span>
    </nav>
    <div class="login-preview-stage"><iframe :srcdoc="source" sandbox="" referrerpolicy="no-referrer" title="登录页效果" :width="size === 'desktop' ? 1200 : 680" :height="size === 'desktop' ? 800 : 560" /></div>
  </dialog>
</template>

<style scoped>
.login-preview-dialog{width:calc(100vw - 48px);max-width:1320px;max-height:calc(100dvh - 48px);padding:24px;border:1px solid #dfe5ed;border-radius:16px;color:#27354a;background:#f8fafc;box-shadow:0 24px 100px #13223740}
.login-preview-dialog::backdrop{background:#12203688}
header{display:flex;align-items:center;justify-content:space-between;gap:20px}h2{margin:0;font-size:20px}p,nav span{font-size:12px;color:#718096}
nav{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:16px 0}label{font-size:13px}select{margin-left:8px;padding:8px;border:1px solid #dfe5ed;border-radius:6px;background:white;color:#27354a}
.login-preview-stage{overflow:auto;max-height:calc(100dvh - 240px);border:1px solid #dfe5ed;border-radius:10px;background:#e6eaf0;padding:12px}
iframe{display:block;margin:auto;border:0;background:white;max-width:none;flex-shrink:0}
</style>
