<script setup lang="ts">
import { ref } from "vue";
import { Check, Copy } from "@lucide/vue";
import { writeClipboardText } from "@/utils/clipboard";
import { useFeedbackStore } from "@/stores/feedback";

const props = defineProps<{ text: unknown; max?: string; mono?: boolean }>();
const max = props.max ?? "";
const mono = props.mono ?? false;
const value = ref(String(props.text ?? "").trim());
const copied = ref(false);
const feedback = useFeedbackStore();

async function copy() {
  if (!value.value) return;
  try {
    await writeClipboardText(value.value);
    copied.value = true;
    feedback.notify("已复制到剪贴板", "success");
    window.setTimeout(() => (copied.value = false), 1200);
  } catch {
    feedback.notify("复制失败，请手动选择文本复制", "error");
  }
}
</script>

<template>
  <span
    class="cell-copy"
    :class="{ mono }"
    :data-full="value"
    @click.stop="copy"
  >
    <span class="cell-copy-text" :style="max ? { maxWidth: max } : undefined">{{ value }}</span>
    <button
      v-if="value"
      type="button"
      class="cell-copy-btn"
      :title="`点击复制：${value}`"
      :aria-label="`点击复制：${value}`"
      @click.stop="copy"
    >
      <Check v-if="copied" :size="12" />
      <Copy v-else :size="12" />
    </button>
  </span>
</template>
