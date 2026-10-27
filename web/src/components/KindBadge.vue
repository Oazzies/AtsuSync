<script setup lang="ts">
import type { SourceKind } from '@atsusync/shared';
import { Badge } from '@/components/ui/badge';
import { tone } from '@/lib/tone';

defineProps<{ kind: SourceKind }>();
</script>

<template>
  <Badge variant="outline" :class="tone(kind === 'scanlation' ? 'success' : kind === 'official' ? 'info' : 'warning')">
    {{ kind === 'scanlation' ? 'Scanlation' : kind === 'official' ? 'Official' : 'Aggregator' }}
  </Badge>
</template>
