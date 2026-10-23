<script setup lang="ts">
import { ImageUp, LoaderCircle } from '@lucide/vue'
import { ref } from 'vue'
import { uploadProjectAsset } from '@/api/delivery-system'
import { toUserMessage } from '@/api/client'

const props = defineProps<{ modelValue: string; label: string; accept?: string; hint?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const uploading = ref(false), error = ref('')

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || uploading.value) return
  uploading.value = true
  error.value = ''
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
      reader.readAsDataURL(file)
    })
    const saved = await uploadProjectAsset(file.name, dataUrl)
    emit('update:modelValue', saved.url)
  } catch (reason) {
    error.value = toUserMessage(reason)
  } finally {
    uploading.value = false
    input.value = ''
  }
}
</script>

<template>
  <div class="project-asset-field">
    <span>{{ label }}</span>
    <div>
      <span class="asset-preview"><img v-if="modelValue" :src="modelValue" :alt="`${label}预览`" /><ImageUp v-else :size="20" /></span>
      <div class="asset-inputs">
        <input :value="modelValue" placeholder="图片 URL，或点击右侧上传" @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
        <label class="secondary-button asset-upload-button"><LoaderCircle v-if="uploading" class="spin" :size="15" /><ImageUp v-else :size="15" />{{ uploading ? '上传中' : '上传' }}<input type="file" :accept="accept || 'image/*'" :disabled="uploading" @change="upload" /></label>
      </div>
    </div>
    <small v-if="hint">{{ hint }}</small><small v-if="error" class="field-error">{{ error }}</small>
  </div>
</template>
