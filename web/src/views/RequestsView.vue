<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ContentRequest } from '@atsusync/shared';
import { api, fmtAgo, useAsync, useServerEvents } from '../api/client';
import StatusBadge from '../components/StatusBadge.vue';

const router = useRouter();
const { data, error, loading, run } = useAsync(api.requests);
const syncing = ref(false);
const syncMsg = ref<string | null>(null);

const q = ref('');
const type = ref('');
const kind = ref('');
const showClosed = ref(false);

const TYPES = ['Manhwa', 'Manga', 'Manhua', 'Comic', 'Novel'];
const CLOSED = new Set(['added', 'cant_add', 'duplicate']);

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  return (data.value ?? []).filter((r: ContentRequest) => {
    if (!showClosed.value && CLOSED.has(r.status)) return false;
    if (type.value && !r.tags.some((t) => t.name === type.value)) return false;
    if (kind.value && r.kind !== kind.value) return false;
    if (needle && !r.title.toLowerCase().includes(needle)) return false;
    return true;
  });
});

async function sync(full: boolean) {
  syncing.value = true;
  syncMsg.value = null;
  try {
    const r = await api.syncRequests(full);
    syncMsg.value = `${r.added} new, ${r.updated} updated`;
    await run();
  } catch (e) {
    syncMsg.value = (e as Error).message;
  } finally {
    syncing.value = false;
  }
}

const typeTags = (r: ContentRequest) => r.tags.filter((t) => TYPES.includes(t.name));

useServerEvents((e) => {
  if (e.type === 'requests_synced' && e.added > 0) void run();
});
onMounted(run);
</script>

<template>
  <div class="stack">
    <div class="row">
      <div>
        <h1>Content requests</h1>
        <div class="muted small">From the Atsumaru forum. Click a request to find sources for it.</div>
      </div>
      <div class="spacer" />
      <span v-if="syncMsg" class="muted small">{{ syncMsg }}</span>
      <button :disabled="syncing" @click="sync(false)">{{ syncing ? 'Syncing…' : 'Sync new' }}</button>
      <button :disabled="syncing" title="Walk every page to pick up status changes on old requests" @click="sync(true)">Full sync</button>
    </div>

    <div class="panel row">
      <input v-model="q" placeholder="Search titles…" style="min-width: 240px" />
      <select v-model="type">
        <option value="">All types</option>
        <option v-for="t in TYPES" :key="t">{{ t }}</option>
      </select>
      <select v-model="kind">
        <option value="">New series + new source</option>
        <option value="new_series">New series</option>
        <option value="new_source">New source</option>
      </select>
      <label class="row small"><input v-model="showClosed" type="checkbox" /> Show added / can't add / duplicate</label>
      <div class="spacer" />
      <span class="muted small">{{ filtered.length }} of {{ data?.length ?? 0 }}</span>
    </div>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-else-if="loading && !data" class="muted">Loading…</div>
    <div v-else-if="data && data.length === 0" class="panel muted">No requests yet. Press “Sync new”.</div>

    <div v-else class="panel" style="padding: 0">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Type</th>
            <th>Status</th>
            <th>Tracker</th>
            <th>Linked</th>
            <th>Posted</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in filtered" :key="r.id" class="clickable" @click="router.push(`/requests/${r.id}`)">
            <td>
              <strong>{{ r.title }}</strong>
              <div class="muted small">
                {{ r.kind === 'new_source' ? 'New source' : r.kind === 'new_series' ? 'New series' : '' }}
                <template v-if="r.authorName"> · {{ r.authorName }}</template>
                · {{ r.commentCount }} comments
              </div>
            </td>
            <td>
              <span v-for="t in typeTags(r)" :key="t.id" class="badge">{{ t.emoji }} {{ t.name }}</span>
            </td>
            <td><StatusBadge :status="r.status" /></td>
            <td>
              <span v-if="r.mangabakaId" class="badge ok">MangaBaka</span>
              <span v-else-if="r.trackers.some((t) => t.kind !== 'other')" class="badge">{{ r.trackers.find((t) => t.kind !== 'other')!.kind }}</span>
              <span v-else class="muted small">none</span>
            </td>
            <td><span v-if="r.linkCount" class="badge accent">{{ r.linkCount }}</span></td>
            <td class="muted small">{{ fmtAgo(r.createdAt) }}</td>
            <td><a :href="r.url" target="_blank" rel="noopener" class="small" @click.stop>Post ↗</a></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
