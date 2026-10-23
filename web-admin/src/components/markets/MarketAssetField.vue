<script setup lang="ts">
import { ImageUp, LoaderCircle } from '@lucide/vue'
import { ref } from 'vue'
import { toUserMessage } from '@/api/client'
import { uploadImage } from '@/api/uploads'

defineProps<{ modelValue: string; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const uploading = ref(false)
const error = ref('')

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
    const saved = await uploadImage(file.name, dataUrl)
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
  <div class="market-asset-field">
    <span>{{ label }}</span>
    <div class="market-asset-control">
      <span class="market-asset-preview">
        <img v-if="modelValue" :src="modelValue" :alt="`${label}预览`" />
        <ImageUp v-else :size="20" />
      </span>
      <div class="market-asset-inputs">
        <input
          :value="modelValue"
          placeholder="图片 URL，或从本地上传"
          @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        />
        <label class="secondary-button market-asset-upload">
          <LoaderCircle v-if="uploading" class="spin" :size="15" />
          <ImageUp v-else :size="15" />
          {{ uploading ? '上传中' : '本地上传' }}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon" :disabled="uploading" @change="upload" />
        </label>
      </div>
    </div>
    <small>支持 PNG、JPG、WebP、GIF、ICO，最大 3 MB。上传后仍可手动修改 URL。</small>
    <small v-if="error" class="field-error" role="alert">{{ error }}</small>
  </div>
</template>

<style scoped src="./market-asset-field.css"></style>
