import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { getPublicSettings } from '@/api/platform'
import type { PublicPlatformSettings } from '@/types/platform'

const DEFAULT_SETTINGS: Required<Pick<PublicPlatformSettings, 'systemName' | 'systemSubtitle' | 'primaryColor' | 'logoText' | 'loginTitle' | 'loginSubtitle'>> = {
  systemName: 'Agent AI',
  systemSubtitle: '运营控制台',
  primaryColor: '#4f46e5',
  logoText: 'AI',
  loginTitle: '把复杂的运营工作，变成清晰的每一步。',
  loginSubtitle: '统一管理专家、能力市场、渠道组织、模型服务与版本分发。',
}

export const usePlatformStore = defineStore('platform', () => {
  const settings = ref<PublicPlatformSettings>({ ...DEFAULT_SETTINGS })
  const initialized = ref(false)

  const systemName = computed(() => settings.value.systemName || DEFAULT_SETTINGS.systemName)
  const systemSubtitle = computed(() => settings.value.systemSubtitle || DEFAULT_SETTINGS.systemSubtitle)
  const logoText = computed(() => settings.value.logoText || DEFAULT_SETTINGS.logoText)

  async function initialize(force = false) {
    if (initialized.value && !force) return
    try {
      settings.value = { ...DEFAULT_SETTINGS, ...await getPublicSettings() }
    } finally {
      initialized.value = true
    }
  }

  watch(() => settings.value.primaryColor, (color) => {
    if (color && /^#[0-9a-f]{6}$/i.test(color)) document.documentElement.style.setProperty('--brand', color)
  }, { immediate: true })

  return { settings, initialized, systemName, systemSubtitle, logoText, initialize }
})
