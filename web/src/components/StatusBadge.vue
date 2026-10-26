<script setup lang="ts">
import { computed } from 'vue';
import type { ChapterState, JobState, RequestStatus } from '@atsusync/shared';
import { Badge } from '@/components/ui/badge';
import { tone, type Tone } from '@/lib/tone';

const props = defineProps<{ status: RequestStatus | ChapterState | JobState }>();

const MAP: Record<string, [string, Tone]> = {
  open: ['Open', 'info'],
  queued: ['Queued', 'warning'],
  looking: ['Looking into it', 'warning'],
  added: ['Added', 'success'],
  cant_add: ["Can't add", 'danger'],
  duplicate: ['Duplicate', 'neutral'],
  known: ['Available', 'neutral'],
  pending: ['New', 'primary'],
  downloaded: ['Downloaded', 'primary'],
  uploaded: ['Uploaded', 'success'],
  skipped: ['Skipped', 'neutral'],
  downloading: ['Downloading', 'info'],
  done: ['Ready', 'success'],
  failed: ['Failed', 'danger'],
  cancelled: ['Cancelled', 'neutral'],
};

const entry = computed((): [string, Tone] => MAP[props.status] ?? [props.status, 'neutral']);
</script>

<template>
  <Badge variant="outline" :class="tone(entry[1])">{{ entry[0] }}</Badge>
</template>
