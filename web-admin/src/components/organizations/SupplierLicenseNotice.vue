<script setup lang="ts">
import { computed } from 'vue'
import { CalendarClock, RefreshCw } from '@lucide/vue'
import type { SupplierLicense } from '@/types/organization'
import { formatLicenseExpiry } from '@/utils/supplier-license'

const props = defineProps<{ license: SupplierLicense | null; now: number; loading?: boolean; error?: string }>()
defineEmits<{ refresh: [] }>()
const visible = computed(() => Boolean(props.license?.id && props.license.id !== 'official-center'))
const expired = computed(() => props.license?.status === 'expired' || Boolean(props.license?.expiresAt && new Date(props.license.expiresAt).getTime() <= props.now))
const nearExpiry = computed(() => Boolean(!expired.value && props.license?.expiresAt && new Date(props.license.expiresAt).getTime() - props.now <= 7 * 24 * 60 * 60_000))
const title = computed(() => props.license?.status === 'disabled' ? '供应商授权已停用' : expired.value ? '供应商授权已到期' : nearExpiry.value ? '供应商授权即将到期' : '供应商授权')
const tone = computed(() => expired.value || props.license?.status === 'disabled' ? 'expired' : nearExpiry.value || !props.license?.verified || props.license?.stale || props.error ? 'warning' : 'active')
const expiry = computed(() => !props.license?.verified && !props.license?.expiresAt ? '到期时间暂不可用' : formatLicenseExpiry(props.license?.expiresAt))
</script>

<template>
  <aside v-if="visible" class="supplier-license-notice" :class="`is-${tone}`" :role="expired ? 'alert' : 'status'">
    <CalendarClock :size="18" />
    <div><strong>{{ title }}</strong><span>到期时间：{{ expiry }}</span><small v-if="expired">请联系上级续期。</small><small v-else-if="error || !license?.verified">{{ error || license?.message || '暂时无法校验授权' }}</small><small v-else-if="license?.stale">当前显示上次校验结果</small></div>
    <button class="text-button" type="button" :disabled="loading" aria-label="刷新授权状态" @click="$emit('refresh')"><RefreshCw :size="14" />{{ loading ? '校验中…' : '刷新授权' }}</button>
  </aside>
</template>
