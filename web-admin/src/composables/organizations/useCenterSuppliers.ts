import { computed, onMounted, ref } from 'vue'
import * as api from '@/api/organization'
import { toUserMessage } from '@/api/client'
import type { CenterSupplier } from '@/types/organization'
import { formatLicenseExpiry } from '@/utils/supplier-license'
export function useCenterSuppliers() {
  const suppliers = ref<CenterSupplier[]>([]), loading = ref(false), errorMessage = ref(''), search = ref('')
  const rows = computed(() => suppliers.value.filter(item => `${item.id} ${item.name}`.toLowerCase().includes(search.value.toLowerCase())))
  async function load() { loading.value = true; errorMessage.value = ''; try { suppliers.value = await api.listCenterSuppliers() } catch (e) { errorMessage.value = toUserMessage(e) } finally { loading.value = false } }
  onMounted(load)
  return { rows, loading, errorMessage, search, load, formatLicenseExpiry }
}
