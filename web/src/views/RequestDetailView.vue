<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { AtsuSeriesState, SourceMatch } from '@atsusync/shared';
import { api, fmtAgo, fmtRanges, useAsync } from '../api/client';
import StatusBadge from '../components/StatusBadge.vue';

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ changed: [] }>();
const router = useRouter();

const { data, error, loading, run } = useAsync(() => api.request(props.id));
const atsu = ref<AtsuSeriesState | null>(null);
const finding = ref(false);
const searched = ref(false);
const findError = ref<string | null>(null);
const pasteUrl = ref('');
const linking = ref<string | null>(null);

const req = computed(() => data.value?.request);
const matches = computed(() => data.value?.matches ?? []);
const linkedUrls = computed(() => new Set((data.value?.links ?? []).map((l) => l.seriesUrl)));

async function load() {
  await run();
  atsu.value = await api.requestAtsu(props.id).catch(() => null);
}

async function findSources() {
  finding.value = true;
  findError.value = null;
  try {
    const m = await api.findSources(props.id);
    if (data.value) data.value.matches = m;
    searched.value = true;
  } catch (e) {
    findError.value = (e as Error).message;
  } finally {
    finding.value = false;
  }
}

async function addByUrl() {
  if (!pasteUrl.value.trim()) return;
  findError.value = null;
  try {
    await api.addSource(props.id, pasteUrl.value.trim());
    pasteUrl.value = '';
    await run();
  } catch (e) {
    findError.value = (e as Error).message;
  }
}

async function link(m: SourceMatch) {
  linking.value = m.seriesUrl;
  try {
    const l = await api.createLink(props.id, m.sourceId, m.seriesUrl);
    emit('changed');
    await router.push(`/links/${l.id}`);
  } catch (e) {
    findError.value = (e as Error).message;
  } finally {
    linking.value = null;
  }
}

const scoreClass = (s: number) => (s >= 0.85 ? 'ok' : s >= 0.6 ? 'warn' : 'err');
const missingVsAtsu = (m: SourceMatch) =>
  m.latestChapter != null && atsu.value?.found && atsu.value.latest != null ? Math.max(0, m.latestChapter - atsu.value.latest) : null;

onMounted(load);
</script>

<template>
  <div class="stack">
    <RouterLink to="/" class="muted small">← Requests</RouterLink>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-else-if="loading && !data" class="muted">Loading…</div>

    <template v-if="req">
      <div class="panel row" style="align-items: flex-start; gap: 16px">
        <img v-if="data?.mangabaka?.cover" :src="data.mangabaka.cover" class="cover" style="width: 90px; height: 128px" />
        <div class="stack" style="gap: 8px; flex: 1">
          <div class="row">
            <h1>{{ req.title }}</h1>
            <StatusBadge :status="req.status" />
            <span v-for="t in req.tags" :key="t.id" class="badge">{{ t.emoji }} {{ t.name }}</span>
          </div>
          <div v-if="data?.mangabaka && data.mangabaka.titles.length > 1" class="muted small">
            Also known as: {{ data.mangabaka.titles.filter((t) => t !== req!.title).join(' · ') }}
          </div>
          <div style="white-space: pre-wrap">{{ req.content }}</div>
          <div class="row small">
            <a :href="req.url" target="_blank" rel="noopener" class="btn">Open post ↗</a>
            <a v-for="t in req.trackers" :key="t.url" :href="t.url" target="_blank" rel="noopener" class="btn">{{ t.kind }} ↗</a>
          </div>
        </div>
      </div>

      <div class="panel">
        <h2>On Atsumaru</h2>
        <div v-if="!atsu" class="muted">Checking…</div>
        <div v-else-if="atsu.error" class="muted">{{ atsu.error }}</div>
        <div v-else-if="atsu.found" class="stack" style="gap: 6px">
          <div>
            <strong>{{ atsu.title ?? atsu.mangaId }}</strong> has
            <strong>{{ atsu.total }}</strong> chapters
            <span v-if="atsu.ranges.length" class="muted">({{ fmtRanges(atsu.ranges) }})</span>
            <span v-if="atsu.waiting.length" class="badge warn">in review: {{ fmtRanges(atsu.waiting) }}</span>
          </div>
          <div v-if="atsu.others.length" class="row small">
            <span class="muted">Uploaded by:</span>
            <span v-for="o in atsu.others" :key="o.id" class="badge">{{ o.label }} · {{ o.chapters }} ch · latest {{ o.latest ?? '—' }}</span>
          </div>
        </div>
        <div v-else class="muted">Not on Atsumaru yet. Uploading creates it from the MangaBaka entry.</div>
      </div>

      <div v-if="data?.links.length" class="panel">
        <h2>Linked sources</h2>
        <table>
          <tbody>
            <tr v-for="l in data.links" :key="l.id" class="clickable" @click="router.push(`/links/${l.id}`)">
              <td><strong>{{ l.sourceName }}</strong> — {{ l.seriesTitle }}</td>
              <td>{{ l.chapterCount }} chapters</td>
              <td><span v-if="l.pendingCount" class="badge accent">{{ l.pendingCount }} new</span></td>
              <td class="muted small">checked {{ fmtAgo(l.lastCheckedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="panel stack">
        <div class="row">
          <h2 style="margin: 0">Sources</h2>
          <div class="spacer" />
          <button class="primary" :disabled="finding" @click="findSources">
            {{ finding ? 'Searching…' : matches.length ? 'Search again' : 'Find sources' }}
          </button>
        </div>
        <div class="muted small">
          Searches each enabled site once with the request title and its tracker alt titles. Open the series on the site to check
          quality before linking.
        </div>
        <div v-if="findError" class="error">{{ findError }}</div>

        <table v-if="matches.length">
          <thead>
            <tr>
              <th></th>
              <th>Site</th>
              <th>Series</th>
              <th>Match</th>
              <th>Chapters</th>
              <th>Latest</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in matches" :key="m.sourceId + m.seriesUrl">
              <td><img v-if="m.cover" :src="m.cover" class="cover" loading="lazy" referrerpolicy="no-referrer" /></td>
              <td>{{ m.sourceName }}</td>
              <td>
                {{ m.title }}
                <div v-if="m.error" class="small" style="color: var(--err)">{{ m.error }}</div>
              </td>
              <td><span class="badge" :class="scoreClass(m.score)">{{ Math.round(m.score * 100) }}%</span></td>
              <td>
                {{ m.chapterCount ?? '—' }}
                <div v-if="missingVsAtsu(m)" class="small" style="color: var(--accent)">+{{ missingVsAtsu(m) }} vs Atsu</div>
              </td>
              <td>{{ m.latestChapter ?? '—' }}</td>
              <td class="row" style="justify-content: flex-end">
                <a v-if="!m.seriesUrl.includes('#')" :href="m.seriesUrl" target="_blank" rel="noopener" class="btn">Open ↗</a>
                <span v-if="linkedUrls.has(m.seriesUrl)" class="badge ok">Linked</span>
                <button v-else-if="!m.error" class="primary" :disabled="linking === m.seriesUrl" @click="link(m)">
                  {{ linking === m.seriesUrl ? 'Linking…' : 'Link' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else-if="!finding" class="muted small">
          {{ searched ? 'No matches on the enabled sites. Paste a series URL below if you know one.' : 'No lookups yet for this request.' }}
        </div>

        <div class="row">
          <input v-model="pasteUrl" placeholder="Or paste a series URL from a supported site…" style="flex: 1" @keyup.enter="addByUrl" />
          <button @click="addByUrl">Add</button>
        </div>
      </div>
    </template>
  </div>
</template>
