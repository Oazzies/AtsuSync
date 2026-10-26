<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, fmtAgo, useAsync, useServerEvents } from '../api/client';

const router = useRouter();
const { data, error, loading, run } = useAsync(api.links);
const withNew = computed(() => (data.value ?? []).filter((l) => l.pendingCount > 0));
const rest = computed(() => (data.value ?? []).filter((l) => l.pendingCount === 0));

useServerEvents((e) => {
  if (e.type === 'new_chapters' || e.type === 'job') void run();
});
onMounted(run);
</script>

<template>
  <div class="stack">
    <div>
      <h1>Tracked series</h1>
      <div class="muted small">Linked sources are re-checked on their interval. New chapters wait here for you to upload or skip.</div>
    </div>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-else-if="loading && !data" class="muted">Loading…</div>
    <div v-else-if="data && !data.length" class="panel muted">Nothing linked yet. Open a request and link a source.</div>

    <div v-if="withNew.length" class="panel" style="padding: 0">
      <table>
        <thead><tr><th>New chapters waiting</th><th>Source</th><th></th><th>Checked</th></tr></thead>
        <tbody>
          <tr v-for="l in withNew" :key="l.id" class="clickable" @click="router.push(`/links/${l.id}`)">
            <td><strong>{{ l.seriesTitle }}</strong><div class="muted small">{{ l.requestTitle }}</div></td>
            <td>{{ l.sourceName }}</td>
            <td><span class="badge accent">{{ l.pendingCount }} new</span></td>
            <td class="muted small">{{ fmtAgo(l.lastCheckedAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="rest.length" class="panel" style="padding: 0">
      <table>
        <thead><tr><th>Series</th><th>Source</th><th>Chapters</th><th>Watching</th><th>Checked</th></tr></thead>
        <tbody>
          <tr v-for="l in rest" :key="l.id" class="clickable" @click="router.push(`/links/${l.id}`)">
            <td><strong>{{ l.seriesTitle }}</strong><div class="muted small">{{ l.requestTitle }}</div></td>
            <td>{{ l.sourceName }}</td>
            <td>{{ l.chapterCount }}</td>
            <td>
              <span v-if="l.watch" class="small">every {{ l.checkIntervalMin < 60 ? `${l.checkIntervalMin}m` : `${l.checkIntervalMin / 60}h` }}</span>
              <span v-else class="muted small">paused</span>
            </td>
            <td class="small">
              <span class="muted">{{ fmtAgo(l.lastCheckedAt) }}</span>
              <div v-if="l.lastError" style="color: var(--err)">{{ l.lastError }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
