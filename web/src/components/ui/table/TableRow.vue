<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <tr
    data-slot="table-row"
    :class="cn('hover:bg-slate3/50 data-[state=selected]:bg-slate3 border-b border-hair transition-colors', props.class)"
  >
    <slot />
  </tr>
</template>
