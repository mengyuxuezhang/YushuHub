<script setup lang="ts">
import { ArrowDown, ArrowUp, Plus, Trash2 } from '@lucide/vue'
import type { ClientMenuItem } from '@/utils/project-menus'

const props = defineProps<{ modelValue: ClientMenuItem[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: ClientMenuItem[]] }>()
const update = (items: ClientMenuItem[]) => emit('update:modelValue', items.map((item, index) => ({ ...item, order: (index + 1) * 10 })))
let nextKey = 0
function add() {
  update([...props.modelValue, { key: `link-${Date.now()}-${++nextKey}`, label: '新链接', type: 'external', url: '', order: props.modelValue.length * 10 + 10, visible: true, openMode: 'system', showAddressBar: true }])
}
function remove(index: number) { update(props.modelValue.filter((_, current) => current !== index)) }
function move(index: number, delta: number) { const items = [...props.modelValue]; const target = index + delta; if (target < 0 || target >= items.length) return; [items[index], items[target]] = [items[target], items[index]]; update(items) }
</script>

<template>
  <div class="client-menu-editor">
    <header><div><h4>客户端外部链接</h4><p>可添加官网、文档、教程或客服入口；仅支持 HTTPS 地址，显示在客户端扩展入口中。</p></div><div><button type="button" class="secondary-button" @click="add"><Plus :size="15" />添加外部链接</button></div></header>
    <p v-if="!modelValue.length" class="client-menu-empty">尚未配置外部链接；不影响客户端内置功能。</p>
    <div v-else class="menu-table-scroll"><table><thead><tr><th>显示</th><th>链接名称</th><th>类型</th><th>HTTPS 地址</th><th>打开方式</th><th>排序</th><th></th></tr></thead><tbody>
      <tr v-for="(item, index) in modelValue" :key="item.key">
        <td><input v-model="item.visible" type="checkbox" :aria-label="`显示链接 ${index + 1}`" /></td><td><input v-model.trim="item.label" maxlength="40" :aria-label="`链接名称 ${index + 1}`" /></td><td><span class="soft-tag">外部链接</span></td>
        <td><input v-model.trim="item.url" type="url" maxlength="300" placeholder="https://example.com" :aria-label="`链接地址 ${index + 1}`" /></td>
        <td><select v-model="item.openMode" :aria-label="`链接打开方式 ${index + 1}`"><option value="system">系统浏览器</option><option value="internal">客户端内置浏览器</option></select><label v-if="item.openMode === 'internal'" class="address-bar-choice"><input v-model="item.showAddressBar" type="checkbox" />显示地址栏</label></td>
        <td><div class="menu-order-actions"><button type="button" :disabled="index === 0" @click="move(index, -1)"><ArrowUp :size="14" /></button><button type="button" :disabled="index === modelValue.length - 1" @click="move(index, 1)"><ArrowDown :size="14" /></button></div></td>
        <td><button type="button" class="icon-danger" title="删除外部链接" @click="remove(index)"><Trash2 :size="15" /></button></td>
      </tr>
    </tbody></table></div>
  </div>
</template>

<style scoped>
.client-menu-editor .client-menu-empty { padding: 18px 14px; font-size: 12px; }
@media (max-width: 700px) { .client-menu-editor > header { flex-wrap: wrap; } }
</style>
