<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-center">
    <div class="flex h-14 w-14 items-center justify-center rounded-lg bg-parchment">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect
          x="3.5"
          y="4.5"
          width="17"
          height="15"
          rx="3"
          stroke="#7a7a7a"
          stroke-width="1.5"
        />
        <path
          d="M4.5 16.5l4.5-4.2 3.4 3.1 3-2.7 3.8 3.6"
          stroke="#7a7a7a"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle cx="8.8" cy="9.4" r="1.5" fill="#7a7a7a" />
      </svg>
    </div>
    <div class="space-y-1.5">
      <p class="text-tagline font-semibold text-ink">{{ title }}</p>
      <p v-if="description" class="text-caption text-weak">{{ description }}</p>
    </div>
    <slot />
  </div>
</template>
