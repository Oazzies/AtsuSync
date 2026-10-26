<script setup lang="ts">
import type { SourceKind } from '@atsusync/shared';
import { Badge } from '@/components/ui/badge';
import { tone } from '@/lib/tone';

defineProps<{ kind: SourceKind }>();
</script>

<template>
  <Badge variant="outline" :class="tone(kind === 'scanlation' ? 'success' : 'warning')">
    {{ kind === 'scanlation' ? 'Scanlation' : 'Aggregator' }}
  </Badge>
</template>
