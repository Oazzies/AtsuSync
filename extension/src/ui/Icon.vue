<script setup lang="ts">
import { computed } from 'vue';
import { ICONS, type IconName } from './icons';

const props = defineProps<{ name: IconName }>();
const def = computed(() => ICONS[props.name].icon);
</script>

<template>
  <svg class="as-icon" :viewBox="`0 0 ${def[0]} ${def[1]}`" fill="currentColor" aria-hidden="true">
    <path :d="def[4] as string" />
  </svg>
</template>
