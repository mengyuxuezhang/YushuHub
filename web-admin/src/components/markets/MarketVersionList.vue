<script setup lang="ts">
import StatusBadge from '@/components/common/StatusBadge.vue'

defineProps<{
  versions: { id: string; version: string; status: string; releaseNotes?: string }[]
  busy: boolean
}>()
defineEmits<{ publish: [id: string] }>()
</script>

<template>
  <div v-if="versions.length" class="version-list">
    <article v-for="version in versions" :key="version.id">
      <div><strong>{{ version.version }}</strong><StatusBadge :status="version.status" /><p>{{ version.releaseNotes || '无更新说明' }}</p></div>
      <button v-if="version.status !== 'published'" type="button" class="text-button" :disabled="busy" @click="$emit('publish', version.id)">发布版本</button>
    </article>
  </div>
</template>
