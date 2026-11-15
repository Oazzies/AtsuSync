<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DownloadJob, Link, SettingsView, SourceInfo } from '@atsusync/shared';
import { api, syncCookiesNow, useServerEvents } from '../api';
import Icon from '../ui/Icon.vue';

const tab = ref<'tracked' | 'sources'>('tracked');
const online = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const query = ref('');

const links = ref<Link[]>([]);
const jobs = ref<DownloadJob[]>([]);
const sources = ref<SourceInfo[]>([]);
const settings = ref<SettingsView | null>(null);

const brokenCovers = ref(new Set<number>());
const collapsedDownloads = ref(new Set<number>());
const expandedDownloads = ref(new Set<number>());

const jobsByLink = computed(() => {
  const map = new Map<number, DownloadJob[]>();
  for (const j of jobs.value) {
    const arr = map.get(j.linkId);
    if (arr) arr.push(j);
    else map.set(j.linkId, [j]);
  }
  return map;
});

const filteredLinks = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return links.value;
  return links.value.filter(
    (l) =>
      l.seriesTitle.toLowerCase().includes(q) ||
      l.requestTitle.toLowerCase().includes(q) ||
      l.sourceName.toLowerCase().includes(q),
  );
});

function jobsForLink(linkId: number): DownloadJob[] {
  return jobsByLink.value.get(linkId) ?? [];
}

function readyCount(linkId: number): number {
  return jobsForLink(linkId).filter((j) => j.state === 'done').length;
}

function activeCount(linkId: number): number {
  return jobsForLink(linkId).filter((j) => j.state === 'queued' || j.state === 'downloading').length;
}

function failedCount(linkId: number): number {
  return jobsForLink(linkId).filter((j) => j.state === 'failed').length;
}

function hasFinishedJobs(linkId: number): boolean {
  return jobsForLink(linkId).some((j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled');
}

function isDownloadsOpen(linkId: number): boolean {
  if (collapsedDownloads.value.has(linkId)) return false;
  if (expandedDownloads.value.has(linkId)) return true;
  return readyCount(linkId) > 0 || activeCount(linkId) > 0 || failedCount(linkId) > 0;
}

function toggleDownloads(linkId: number) {
  const open = isDownloadsOpen(linkId);
  const nextCollapsed = new Set(collapsedDownloads.value);
  const nextExpanded = new Set(expandedDownloads.value);
  if (open) {
    nextCollapsed.add(linkId);
    nextExpanded.delete(linkId);
  } else {
    nextCollapsed.delete(linkId);
    nextExpanded.add(linkId);
  }
  collapsedDownloads.value = nextCollapsed;
  expandedDownloads.value = nextExpanded;
}

function markBrokenCover(linkId: number) {
  const next = new Set(brokenCovers.value);
  next.add(linkId);
  brokenCovers.value = next;
}

async function load() {
  error.value = null;
  try {
    const [s, l, d, src] = await Promise.all([api.settings(), api.links(), api.downloads(), api.sources()]);
    online.value = true;
    settings.value = s;
    links.value = l;
    jobs.value = d;
    sources.value = src;
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 0) online.value = false;
    error.value = err.message;
  }
}

onMounted(load);

useServerEvents((ev) => {
  if (ev.type === 'job') {
    const idx = jobs.value.findIndex((j) => j.id === ev.job.id);
    if (idx >= 0) jobs.value[idx] = ev.job;
    else jobs.value.unshift(ev.job);
    if (ev.job.state === 'done' || ev.job.state === 'failed') {
      void api.links().then((l) => (links.value = l));
    }
  } else if (ev.type === 'new_chapters' || ev.type === 'chapters_unlocked') {
    void api.links().then((l) => (links.value = l));
  }
});

function atsuUrlForLink(l: Link): string {
  if (l.atsuMangaId) return `https://atsu.moe/manga/${l.atsuMangaId}`;
  if (l.requestId.startsWith('atsu:')) return `https://atsu.moe/manga/${l.requestId.slice(5)}`;
  return `https://atsu.moe/social/forum/cms0o0eh80000uj0lmpkut6tc/content-requests/${l.requestId}`;
}

async function openUrl(url: string) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== undefined && active.url?.startsWith('https://atsu.moe/')) {
    await chrome.tabs.update(active.id, { url });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function checkLink(id: number) {
  busy.value = true;
  try {
    await api.checkLink(id);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function markUploaded(j: DownloadJob) {
  busy.value = true;
  try {
    await api.setChapterState([j.chapterId], 'uploaded');
    await api.deleteDownload(j.id);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function retryJob(id: number) {
  await api.retryDownload(id);
  await load();
}

async function cancelJob(id: number) {
  await api.cancelDownload(id);
  await load();
}

async function clearFinished(linkId: number) {
  busy.value = true;
  try {
    await api.clearDownloads(linkId);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function toggleSource(s: SourceInfo) {
  sources.value = await api.setSourceEnabled(s.id, !s.enabled);
}

async function syncCookie() {
  busy.value = true;
  error.value = null;
  try {
    settings.value = await syncCookiesNow();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function syncRequests() {
  busy.value = true;
  error.value = null;
  try {
    await api.syncRequests(false);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="sp-shell">
    <header class="sp-header">
      <div class="sp-brand">
        <span class="sp-wordmark">Atsu<span>Sync</span></span>
        <span class="sp-dot" :class="{ off: !online }" :title="online ? 'Server online' : 'Server offline'" />
      </div>
      <div class="sp-header-actions">
        <span v-if="settings?.atsuUser" class="sp-badge green sp-user-chip" :title="settings.atsuUser">
          {{ settings.atsuUser }}
        </span>
        <button class="sp-btn sm" :disabled="busy" title="Refresh" @click="load">
          <Icon name="refresh" :class="{ 'sp-spin': busy }" />
          <span>Refresh</span>
        </button>
      </div>
    </header>

    <div class="sp-tabs-wrap">
      <div class="sp-tabs" role="tablist">
        <button class="sp-tab" role="tab" :aria-selected="tab === 'tracked'" :class="{ active: tab === 'tracked' }" @click="tab = 'tracked'">
          <Icon name="bell" />
          <span>Tracked</span>
          <span class="sp-tab-count">{{ links.length }}</span>
        </button>
        <button class="sp-tab" role="tab" :aria-selected="tab === 'sources'" :class="{ active: tab === 'sources' }" @click="tab = 'sources'">
          <Icon name="globe" />
          <span>Sources</span>
        </button>
      </div>
    </div>

    <main class="sp-body">
      <div v-if="error" class="sp-error">{{ error }}</div>

      <template v-if="tab === 'tracked'">
        <div v-if="links.length > 2" class="sp-search-wrap">
          <span class="sp-search-icon"><Icon name="search" /></span>
          <input v-model="query" class="sp-input with-icon" type="search" placeholder="Filter tracked series…" />
        </div>

        <div v-if="!links.length" class="sp-card">
          <div class="sp-muted">No linked series yet. Open any content request or manga page on atsu.moe to link a source.</div>
        </div>
        <div v-else-if="!filteredLinks.length" class="sp-card">
          <div class="sp-muted">No tracked series match "{{ query }}".</div>
        </div>

        <article v-for="l in filteredLinks" :key="l.id" class="sp-card">
          <div class="sp-series-head">
            <div class="sp-cover-wrap">
              <img
                v-if="l.cover && !brokenCovers.has(l.id)"
                :src="l.cover"
                :alt="l.seriesTitle"
                class="sp-cover"
                loading="lazy"
                referrerpolicy="no-referrer"
                @error="markBrokenCover(l.id)"
              />
              <div v-else class="sp-cover-fallback" aria-hidden="true">
                <Icon name="book" />
              </div>
            </div>

            <div class="sp-series-info">
              <div class="sp-series-title" :title="l.seriesTitle">{{ l.seriesTitle }}</div>
              <div class="sp-series-meta" :title="`${l.sourceName} · ${l.chapterCount} chapters`">
                {{ l.sourceName }} · {{ l.chapterCount }} ch
              </div>
              <div
                v-if="l.pendingCount || readyCount(l.id) || activeCount(l.id) || failedCount(l.id)"
                class="sp-badges"
              >
                <span v-if="l.pendingCount" class="sp-badge indigo">{{ l.pendingCount }} new</span>
                <span v-if="readyCount(l.id)" class="sp-badge green">{{ readyCount(l.id) }} ready</span>
                <span v-if="activeCount(l.id)" class="sp-badge indigo">{{ activeCount(l.id) }} downloading</span>
                <span v-if="failedCount(l.id)" class="sp-badge red">{{ failedCount(l.id) }} failed</span>
              </div>
            </div>
          </div>

          <div v-if="l.lastError" class="sp-error">{{ l.lastError }}</div>

          <div class="sp-series-actions">
            <button class="sp-btn primary" @click="openUrl(atsuUrlForLink(l))">
              <Icon name="external" /> Open on Atsu
            </button>
            <button class="sp-btn compact" :disabled="busy" @click="checkLink(l.id)">
              <Icon name="refresh" /> Check
            </button>
            <button
              v-if="jobsForLink(l.id).length"
              class="sp-btn compact"
              :aria-expanded="isDownloadsOpen(l.id)"
              @click="toggleDownloads(l.id)"
            >
              <Icon name="download" />
              <span>{{ jobsForLink(l.id).length }}</span>
              <Icon name="chevronDown" class="sp-chevron" :class="{ open: isDownloadsOpen(l.id) }" />
            </button>
          </div>

          <div v-if="jobsForLink(l.id).length && isDownloadsOpen(l.id)" class="sp-downloads">
            <div class="sp-downloads-head">
              <span class="sp-downloads-label">Downloads</span>
              <button
                v-if="hasFinishedJobs(l.id)"
                class="sp-btn ghost sm"
                :disabled="busy"
                title="Clear finished downloads"
                @click="clearFinished(l.id)"
              >
                <Icon name="trash" /> Clear
              </button>
            </div>

            <div v-for="j in jobsForLink(l.id)" :key="j.id" class="sp-job">
              <div class="sp-job-head">
                <span class="sp-job-title" :title="j.chapterLabel">{{ j.chapterLabel }}</span>
                <span
                  class="sp-badge"
                  :class="{
                    green: j.state === 'done',
                    indigo: j.state === 'downloading' || j.state === 'queued',
                    red: j.state === 'failed',
                  }"
                >
                  {{
                    j.state === 'done'
                      ? 'ready'
                      : j.state === 'downloading' && j.total
                        ? `${j.progress}/${j.total}`
                        : j.state
                  }}
                </span>
              </div>

              <div v-if="j.state === 'downloading' && j.total > 0" class="sp-progress">
                <div class="sp-progress-bar" :style="{ width: `${Math.min(100, Math.round((j.progress / j.total) * 100))}%` }" />
              </div>

              <div v-if="j.error" class="sp-error">{{ j.error }}</div>

              <div class="sp-row-wrap">
                <button v-if="j.state === 'done'" class="sp-btn sm primary" @click="openUrl(j.uploadUrl)">
                  <Icon name="upload" /> Open Upload
                </button>
                <button v-if="j.state === 'done'" class="sp-btn sm good" :disabled="busy" @click="markUploaded(j)">
                  <Icon name="check" /> Mark uploaded
                </button>
                <button v-if="j.state === 'failed' || j.state === 'cancelled'" class="sp-btn sm" @click="retryJob(j.id)">
                  <Icon name="undo" /> Retry
                </button>
                <button v-if="j.state === 'queued' || j.state === 'downloading'" class="sp-btn sm danger" @click="cancelJob(j.id)">
                  <Icon name="x" /> Cancel
                </button>
              </div>
            </div>
          </div>
        </article>
      </template>

      <template v-else>
        <div class="sp-card">
          <div class="sp-row">
            <div style="min-width: 0">
              <div class="sp-title">Atsumaru Session</div>
              <div class="sp-muted">
                {{ settings?.atsuUser ? `Signed in as ${settings.atsuUser}` : 'Cookie not synced yet' }}
              </div>
            </div>
            <button class="sp-btn" :disabled="busy" @click="syncCookie"><Icon name="refresh" /> Sync cookie</button>
          </div>
          <div class="sp-row">
            <span class="sp-muted">Forum requests</span>
            <button class="sp-btn" :disabled="busy" @click="syncRequests"><Icon name="refresh" /> Sync now</button>
          </div>
        </div>

        <div class="sp-card">
          <div class="sp-section-title">Scanlation &amp; Aggregator Sources</div>
          <label v-for="s in sources" :key="s.id" class="sp-source-row">
            <span class="sp-source-name">
              <span>{{ s.name }}</span>
              <span class="sp-muted">({{ s.kind }})</span>
            </span>
            <input type="checkbox" :checked="s.enabled" @change="toggleSource(s)" />
          </label>
        </div>
      </template>
    </main>
  </div>
</template>
