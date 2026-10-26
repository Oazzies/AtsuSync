<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { LinkChapter } from '@atsusync/shared';
import { api, fmtAgo, fmtRanges, useAsync, useServerEvents } from '../api/client';
import StatusBadge from '../components/StatusBadge.vue';

const props = defineProps<{ id: number }>();
const emit = defineEmits<{ changed: [] }>();
const router = useRouter();

const { data, error, loading, run } = useAsync(() => api.link(props.id));
const selected = ref(new Set<number>());
const busy = ref(false);
const msg = ref<string | null>(null);
const dryRun = ref(true);
const filter = ref<'all' | 'missing'>('missing');

const link = computed(() => data.value?.link);
const chapters = computed(() => {
  const all = [...(data.value?.chapters ?? [])].reverse();
  return filter.value === 'missing' ? all.filter((c) => !c.onAtsu && c.state !== 'uploaded' && c.state !== 'skipped') : all;
});
const uploadable = (c: LinkChapter) => !c.locked && !c.onAtsu && c.state !== 'queued' && c.state !== 'uploaded';

// Pre-select new (pending) chapters that Atsumaru doesn't have.
watch(data, (d) => {
  selected.value = new Set((d?.chapters ?? []).filter((c) => c.state === 'pending' && uploadable(c)).map((c) => c.id));
});

function toggle(id: number) {
  const s = new Set(selected.value);
  s.has(id) ? s.delete(id) : s.add(id);
  selected.value = s;
}
function selectAllMissing() {
  selected.value = new Set(chapters.value.filter(uploadable).map((c) => c.id));
}

async function act(fn: () => Promise<unknown>, done?: string) {
  busy.value = true;
  msg.value = null;
  try {
    await fn();
    if (done) msg.value = done;
    await run();
    emit('changed');
  } catch (e) {
    msg.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

const upload = () =>
  act(async () => {
    const jobs = await api.upload([...selected.value]);
    msg.value = `Queued ${jobs.length} chapter(s)${dryRun.value ? ' as dry run' : ''}.`;
  });
const skip = () => act(() => api.setChapterState([...selected.value], 'skipped'), 'Marked as skipped.');
const checkNow = () => act(async () => {
  const r = await api.checkLink(props.id);
  msg.value = r.added ? `${r.added} new chapter(s) found.` : 'No new chapters.';
});
const toggleWatch = () => act(() => api.updateLink(props.id, { watch: !link.value!.watch }));
const setInterval_ = (e: Event) => act(() => api.updateLink(props.id, { checkIntervalMin: Number((e.target as HTMLSelectElement).value) }));
async function remove() {
  if (!confirm('Remove this link and its chapter history?')) return;
  await api.deleteLink(props.id);
  emit('changed');
  await router.push(link.value ? `/requests/${link.value.requestId}` : '/tracked');
}

useServerEvents((e) => {
  if ((e.type === 'job' && e.job.linkId === props.id && ['done', 'failed', 'cancelled'].includes(e.job.state)) ||
      (e.type === 'new_chapters' && e.linkId === props.id)) void run();
});

onMounted(async () => {
  await run();
  dryRun.value = (await api.settings().catch(() => null))?.dryRun ?? true;
});
</script>

<template>
  <div class="stack">
    <RouterLink v-if="link" :to="`/requests/${link.requestId}`" class="muted small">← {{ link.requestTitle }}</RouterLink>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-else-if="loading && !data" class="muted">Loading…</div>

    <template v-if="link && data">
      <div class="panel row">
        <div>
          <h1>{{ link.seriesTitle }}</h1>
          <div class="muted small">
            {{ link.sourceName }} · checked {{ fmtAgo(link.lastCheckedAt) }}
            <span v-if="link.lastError" style="color: var(--err)"> · {{ link.lastError }}</span>
          </div>
        </div>
        <div class="spacer" />
        <a :href="link.seriesUrl" target="_blank" rel="noopener" class="btn">Open on {{ link.sourceName }} ↗</a>
        <button :disabled="busy" @click="checkNow">Check now</button>
        <label class="row small">
          <input type="checkbox" :checked="link.watch" @change="toggleWatch" /> Watch every
        </label>
        <select :value="link.checkIntervalMin" :disabled="!link.watch" @change="setInterval_">
          <option v-for="m in [15, 30, 60, 120, 360, 720, 1440]" :key="m" :value="m">{{ m < 60 ? `${m} min` : `${m / 60} h` }}</option>
        </select>
        <button class="danger ghost" @click="remove">Unlink</button>
      </div>

      <div class="panel">
        <span v-if="data.atsu?.found">
          Atsumaru has <strong>{{ data.atsu.total }}</strong> chapters of
          <strong>{{ data.atsu.title ?? data.atsu.mangaId }}</strong>
          <span class="muted">({{ fmtRanges(data.atsu.ranges) || 'none' }})</span>; {{ link.sourceName }} has <strong>{{ data.chapters.length }}</strong>.
          <span v-if="data.atsu.waiting.length" class="badge warn">in review: {{ fmtRanges(data.atsu.waiting) }}</span>
        </span>
        <span v-else class="muted">
          Series not found on Atsumaru{{ data.atsu?.error ? ` (${data.atsu.error})` : '' }} — every chapter counts as missing.
        </span>
      </div>

      <div class="panel stack">
        <div class="row">
          <select v-model="filter">
            <option value="missing">Missing on Atsumaru</option>
            <option value="all">All chapters</option>
          </select>
          <button class="ghost" @click="selectAllMissing">Select all uploadable</button>
          <button class="ghost" @click="selected = new Set()">Clear</button>
          <div class="spacer" />
          <span v-if="msg" class="small">{{ msg }}</span>
          <button :disabled="busy || !selected.size" @click="skip">Skip</button>
          <button class="primary" :disabled="busy || !selected.size" @click="upload">
            {{ dryRun ? 'Dry-run upload' : 'Upload' }} {{ selected.size || '' }}
          </button>
        </div>

        <table>
          <thead>
            <tr>
              <th style="width: 32px"></th>
              <th>Chapter</th>
              <th>State</th>
              <th>Atsumaru</th>
              <th>First seen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in chapters" :key="c.id">
              <td><input type="checkbox" :checked="selected.has(c.id)" :disabled="!uploadable(c)" @change="toggle(c.id)" /></td>
              <td>
                {{ c.label }}
                <span v-if="c.locked" class="badge warn" title="Paid / early access on the source">Locked</span>
              </td>
              <td><StatusBadge :status="c.state" /></td>
              <td><span v-if="c.onAtsu" class="badge ok">Has it</span><span v-else class="muted small">missing</span></td>
              <td class="muted small">{{ fmtAgo(c.firstSeenAt) }}</td>
              <td><a :href="c.url" target="_blank" rel="noopener" class="small">Read ↗</a></td>
            </tr>
            <tr v-if="!chapters.length">
              <td colspan="6" class="muted">Nothing missing — Atsumaru is up to date with this source.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
