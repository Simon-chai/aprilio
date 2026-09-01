<script setup lang="ts">
const props = withDefaults(defineProps<{ padded?: boolean; fill?: boolean }>(), {
  padded: true,
  fill: false,
});
</script>

<template>
  <section
    class="rounded-lg border border-hairline bg-canvas"
    :class="[props.padded ? 'p-6' : '', props.fill ? 'h-full' : '']"
  >
    <slot />
  </section>
</template>
