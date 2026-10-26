<script setup lang="ts">
import { computed } from 'vue';
import type { ChapterState, JobState, RequestStatus } from '@atsusync/shared';

const props = defineProps<{ status: RequestStatus | ChapterState | JobState }>();

const MAP: Record<string, [string, string]> = {
  open: ['Open', 'info'],
  queued: ['Queued', 'warn'],
  looking: ['Looking into it', 'warn'],
  added: ['Added', 'ok'],
  cant_add: ["Can't add", 'err'],
  duplicate: ['Duplicate', ''],
  known: ['Available', ''],
  pending: ['New', 'accent'],
  uploaded: ['Uploaded', 'ok'],
  skipped: ['Skipped', ''],
  downloading: ['Downloading', 'info'],
  uploading: ['Uploading', 'info'],
  submitting: ['Submitting', 'info'],
  done: ['Done', 'ok'],
  failed: ['Failed', 'err'],
  cancelled: ['Cancelled', ''],
};

const entry = computed(() => MAP[props.status] ?? [props.status, '']);
</script>

<template>
  <span class="badge" :class="entry[1]">{{ entry[0] }}</span>
</template>
