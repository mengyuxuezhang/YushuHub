<script setup lang="ts">
import type { UsageUser } from '@/types/user-usage'
import { usageNumber as num, usageDate } from '@/utils/user-usage'
defineProps<{ items: UsageUser[] }>()
defineEmits<{ detail: [id: string] }>()
</script>
<template>
  <div class="data-table-scroll"><table class="data-table usage-users-table">
    <thead><tr><th>用户</th><th>组织 / 项目</th><th>使用次数</th><th>活跃天数</th><th>消耗积分</th><th>输入 / 输出 Token</th><th>缓存 Token</th><th>图片张数</th><th>语音用量</th><th>最后使用（全历史）</th></tr></thead>
    <tbody><tr v-for="user in items" :key="user.userId">
      <td><button class="text-button" @click="$emit('detail', user.userId)">{{ user.displayName || user.username }}</button><small class="cell-note">{{ user.username }}</small></td>
      <td>{{ user.organizationName }}<small class="cell-note">{{ user.projectName }}</small></td><td>{{ num(user.requests) }}</td><td>{{ user.activeDays }}</td><td>{{ num(user.points) }}</td>
      <td>{{ num(user.inputTokens) }} / {{ num(user.outputTokens) }}</td><td>{{ num(user.cachedTokens) }}</td><td>{{ num(user.images) }}</td>
      <td>{{ num(user.audioCharacters) }} 字符<small class="cell-note">{{ num(user.audioSeconds) }} 秒</small></td><td>{{ usageDate(user.lastUsedAt) }}</td>
    </tr></tbody>
  </table></div>
</template>
