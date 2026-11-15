<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="flex flex-wrap items-end gap-3">
    <div class="min-w-0 flex-1">
      <h1 class="text-2xl font-bold text-foreground2">{{ title }}</h1>
      <p v-if="description" class="mt-1 text-sm text-foreground3">{{ description }}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2"><slot /></div>
  </div>
</template>
