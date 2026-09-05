<script setup lang="ts">
defineProps<{ name: string }>();
</script>

<template>
  <div class="p-8">
    <h1>{{ name }}</h1>
  </div>
</template>
