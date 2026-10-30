<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ status: string; label?: string }>()
const labels: Record<string, string> = { expired: '已到期', draft: '草稿', published: '已发布', enabled: '已启用', disabled: '已停用', invited: '待加入', departed: '已离职', suspended: '已暂停', closed: '已关闭', available: '已上架', blocked: '已阻止', pending_version: '待选版本', queued: '待同步', running: '进行中', succeeded: '已成功', failed: '失败', online: '在线', offline: '离线', paid: '已支付', refunding: '退款处理中', refunded: '已退款', unused: '未使用' }
const tone = computed(() => ['published', 'available', 'enabled', 'succeeded', 'online', 'paid', 'refunded'].includes(props.status) ? 'success' : ['expired', 'failed', 'blocked', 'offline', 'closed'].includes(props.status) ? 'danger' : ['draft', 'pending_version', 'queued', 'invited', 'refunding'].includes(props.status) ? 'warning' : 'neutral')
</script>

<template><span class="status-badge" :class="`is-${tone}`"><i></i>{{ label || labels[status] || status || '未知' }}</span></template>
