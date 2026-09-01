<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{ tone?: "info" | "neutral" | "success" }>(), {
  tone: "info",
});

const cls = computed(() => {
  if (props.tone === "success")
    return "bg-[#e8f5ea] text-success";
  if (props.tone === "neutral") return "bg-parchment text-weak";
  return "bg-primary-soft text-primary";
});
</script>

<template>
  <span
    class="inline-flex items-center rounded-pill px-2.5 py-[5px] text-fine font-semibold"
    :class="cls"
  >
    <slot />
  </span>
</template>
