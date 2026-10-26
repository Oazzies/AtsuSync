<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { UploadJob } from '@atsusync/shared';
import { api, fmtAgo, useServerEvents } from '../api/client';
import StatusBadge from '../components/StatusBadge.vue';

const jobs = ref<UploadJob[]>([]);
const error = ref<string | null>(null);
const open = ref(new Set<number>());

async function load() {
  try {
    jobs.value = await api.uploads();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

useServerEvents((e) => {
  if (e.type !== 'job') return;
  const i = jobs.value.findIndex((j) => j.id === e.job.id);
  if (i === -1) jobs.value.unshift(e.job);
  else jobs.value[i] = e.job;
});

const active = (j: UploadJob) => !['done', 'failed', 'cancelled'].includes(j.state);
function toggle(id: number) {
  const s = new Set(open.value);
  s.has(id) ? s.delete(id) : s.add(id);
  open.value = s;
}

onMounted(load);
</script>

<template>
  <div class="stack">
    <div>
      <h1>Uploads</h1>
      <div class="muted small">Two chapters run at once; chapters of the same series go up in order.</div>
    </div>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="!jobs.length" class="panel muted">No uploads yet.</div>

    <div v-for="j in jobs" :key="j.id" class="panel">
      <div class="row">
        <strong>{{ j.seriesTitle }}</strong>
        <span>{{ j.chapterLabel }}</span>
        <span class="muted small">from {{ j.sourceName }}</span>
        <StatusBadge :status="j.state" />
        <span v-if="j.dryRun" class="badge warn">dry run</span>
        <div class="spacer" />
        <div v-if="active(j) && j.total" class="progress" :title="`${j.progress}/${j.total}`">
          <div :style="{ width: `${(j.progress / j.total) * 100}%` }" />
        </div>
        <span class="muted small">{{ fmtAgo(j.updatedAt) }}</span>
        <button v-if="active(j)" class="ghost" @click="api.cancelUpload(j.id)">Cancel</button>
        <button v-if="j.state === 'failed' || j.state === 'cancelled'" @click="api.retryUpload(j.id)">Retry</button>
        <RouterLink :to="`/links/${j.linkId}`" class="btn ghost">Series</RouterLink>
        <button class="ghost" @click="toggle(j.id)">{{ open.has(j.id) ? 'Hide log' : 'Log' }}</button>
      </div>
      <div v-if="j.error" class="error small" style="margin-top: 8px">{{ j.error }}</div>
      <pre v-if="open.has(j.id)" class="log">{{ j.log.join('\n') }}</pre>
    </div>
  </div>
</template>
