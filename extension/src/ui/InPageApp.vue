<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ContentRequest, DownloadJob, Link, MangaBaka, SourceMatch } from '@atsusync/shared';
import { api, fetchDownloadFile, openSidePanel, useServerEvents } from '../api';
import LinkSection from './LinkSection.vue';
import Icon from './Icon.vue';

type Route =
  | { kind: 'request'; postId: string }
  | { kind: 'manga'; mangaId: string }
  | { kind: 'upload'; mangaId: string | null }
  | { kind: 'other' };

function parseRoute(href: string): Route {
  const u = new URL(href);
  const p = u.pathname;
  const reqMatch = p.match(/^\/social\/forum\/[^/]+\/content-requests\/([^/]+)\/?$/);
  if (reqMatch?.[1]) return { kind: 'request', postId: reqMatch[1] };
  const mangaMatch = p.match(/^\/manga\/([^/]+)\/?$/);
  if (mangaMatch?.[1]) return { kind: 'manga', mangaId: mangaMatch[1] };
  if (p === '/upload' || p.startsWith('/upload/')) {
    return { kind: 'upload', mangaId: u.searchParams.get('manga') };
  }
  return { kind: 'other' };
}

const route = ref<Route>(parseRoute(location.href));
const collapsed = ref(false);
const serverOnline = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

// Request / Manga state
const requestData = ref<ContentRequest | null>(null);
const mangabaka = ref<MangaBaka | null>(null);
const mbMismatch = ref(false);
const mbChecking = ref(false);
const matches = ref<SourceMatch[]>([]);
const brokenCovers = ref(new Set<string>());
const links = ref<Link[]>([]);
const customSourceUrl = ref('');

// Dock position & size (persisted in chrome.storage.local)
const BOUNDS_KEY = 'atsusync_dock_bounds';
const MIN_W = 280;
const MIN_H = 220;
const dockEl = ref<HTMLElement | null>(null);
const dockBounds = ref<{ x: number; y: number; width: number; height: number | null }>({
  x: Math.max(12, window.innerWidth - 380 - 16),
  y: 88,
  width: 380,
  height: null,
});
const dragging = ref(false);

function clampBounds(b: { x: number; y: number; width: number; height: number | null }) {
  const maxW = Math.max(MIN_W, Math.min(820, window.innerWidth - 24));
  const width = Math.min(Math.max(b.width, MIN_W), maxW);
  const maxH = Math.max(MIN_H, window.innerHeight - 24);
  const height = b.height === null ? null : Math.min(Math.max(b.height, MIN_H), maxH);
  const x = Math.min(Math.max(8, b.x), Math.max(8, window.innerWidth - width - 8));
  const y = Math.min(Math.max(8, b.y), Math.max(8, window.innerHeight - 60));
  return { x, y, width, height };
}

function saveBounds() {
  try {
    void chrome.storage?.local?.set({ [BOUNDS_KEY]: dockBounds.value });
  } catch {
    /* ignore */
  }
}

const dockStyle = computed(() => {
  const b = dockBounds.value;
  return {
    left: `${b.x}px`,
    top: `${b.y}px`,
    right: 'auto',
    width: `${b.width}px`,
    ...(b.height !== null ? { height: `${b.height}px` } : { maxHeight: `${Math.max(MIN_H, window.innerHeight - b.y - 16)}px` }),
  };
});

function startDrag(e: PointerEvent) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement | null)?.closest('button, a, input')) return;
  e.preventDefault();
  dragging.value = true;
  const startX = e.clientX;
  const startY = e.clientY;
  const origX = dockBounds.value.x;
  const origY = dockBounds.value.y;

  const onMove = (ev: PointerEvent) => {
    dockBounds.value = clampBounds({
      ...dockBounds.value,
      x: origX + (ev.clientX - startX),
      y: origY + (ev.clientY - startY),
    });
  };
  const onUp = () => {
    dragging.value = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    saveBounds();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

type ResizeDir = 'w' | 'e' | 's' | 'sw' | 'se';
function startResize(dir: ResizeDir, e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startY = e.clientY;
  const orig = { ...dockBounds.value };
  const origH = orig.height ?? dockEl.value?.getBoundingClientRect().height ?? 420;

  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    let { x, y, width } = orig;
    let height = origH;

    if (dir === 'w' || dir === 'sw') {
      const maxW = Math.max(MIN_W, Math.min(820, window.innerWidth - 24));
      const nextW = Math.min(Math.max(orig.width - dx, MIN_W), maxW);
      x = orig.x + (orig.width - nextW);
      width = nextW;
    }
    if (dir === 'e' || dir === 'se') {
      width = orig.width + dx;
    }
    if (dir === 's' || dir === 'sw' || dir === 'se') {
      height = origH + dy;
    }
    dockBounds.value = clampBounds({ x, y, width, height });
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    saveBounds();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function onWindowResize() {
  dockBounds.value = clampBounds(dockBounds.value);
}

function markBrokenCover(url: string) {
  const next = new Set(brokenCovers.value);
  next.add(url);
  brokenCovers.value = next;
}

// Upload state
const readyJobs = ref<DownloadJob[]>([]);
const showAllUploads = ref(false);

const activeId = computed(() => {
  if (route.value.kind === 'request') return route.value.postId;
  if (route.value.kind === 'manga') return `atsu:${route.value.mangaId}`;
  return null;
});

const visibleUploadJobs = computed(() => {
  if (route.value.kind !== 'upload') return [];
  const mangaId = route.value.mangaId;
  if (!mangaId || showAllUploads.value) return readyJobs.value;
  const filtered = readyJobs.value.filter((j) => j.uploadUrl.includes(`manga=${mangaId}`));
  return filtered.length ? filtered : readyJobs.value;
});

async function loadRoute() {
  error.value = null;
  notice.value = null;
  requestData.value = null;
  mangabaka.value = null;
  mbMismatch.value = false;
  matches.value = [];
  brokenCovers.value = new Set();
  links.value = [];

  if (route.value.kind === 'upload') {
    await loadUploads();
    return;
  }
  if (!activeId.value) {
    try {
      await api.settings();
      serverOnline.value = true;
    } catch {
      serverOnline.value = false;
    }
    return;
  }

  try {
    const res = await api.request(activeId.value);
    serverOnline.value = true;
    requestData.value = res.request;
    mangabaka.value = res.mangabaka;
    matches.value = res.matches;
    links.value = res.links;
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 0) serverOnline.value = false;
    else serverOnline.value = true;
    if (err.status !== 404) {
      error.value = err.message;
    }
  }
}

async function checkMangaBaka() {
  if (!activeId.value) return;
  mbChecking.value = true;
  error.value = null;
  try {
    const res = await api.checkMangaBaka(activeId.value);
    mangabaka.value = res.mangabaka;
    mbMismatch.value = res.mediumMismatch;
    if (!res.mangabaka) {
      notice.value = 'No matching MangaBaka entry found for this medium';
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    mbChecking.value = false;
  }
}

async function loadUploads() {
  try {
    const all = await api.downloads();
    serverOnline.value = true;
    readyJobs.value = all.filter((j) => j.state === 'done');
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 0) serverOnline.value = false;
    error.value = err.message;
  }
}

async function trackCurrentManga() {
  if (route.value.kind !== 'manga') return;
  busy.value = true;
  error.value = null;
  try {
    await api.addSeries(location.href);
    await loadRoute();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function findSources() {
  if (!activeId.value) return;
  busy.value = true;
  error.value = null;
  try {
    matches.value = await api.findSources(activeId.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function addCustomSource() {
  if (!activeId.value || !customSourceUrl.value.trim()) return;
  busy.value = true;
  error.value = null;
  try {
    const m = await api.addSource(activeId.value, customSourceUrl.value.trim());
    matches.value = [m, ...matches.value.filter((x) => x.seriesUrl !== m.seriesUrl)];
    customSourceUrl.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function linkSource(m: SourceMatch) {
  if (!activeId.value) return;
  busy.value = true;
  error.value = null;
  try {
    await api.createLink(activeId.value, m.sourceId, m.seriesUrl);
    await loadRoute();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function attachZipToUploadPage(job: DownloadJob) {
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    const { bytes, filename, mime } = await fetchDownloadFile(job.id);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) {
      throw new Error('Could not find file input on this page — use Save ZIP instead');
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const file = new File([copy.buffer], filename, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await api.setChapterState([job.chapterId], 'uploaded');
    await api.deleteDownload(job.id);
    readyJobs.value = readyJobs.value.filter((j) => j.id !== job.id);
    notice.value = `Attached ${filename} to page`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function attachAllZipsToUploadPage() {
  const jobsToAttach = [...visibleUploadJobs.value];
  if (!jobsToAttach.length) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) {
      throw new Error('Could not find file input on this page — use Save ZIP instead');
    }
    if (input.multiple) {
      const dt = new DataTransfer();
      for (const job of jobsToAttach) {
        const { bytes, filename, mime } = await fetchDownloadFile(job.id);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        dt.items.add(new File([copy.buffer], filename, { type: mime }));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await api.setChapterState(
        jobsToAttach.map((j) => j.chapterId),
        'uploaded',
      );
      await Promise.all(jobsToAttach.map((j) => api.deleteDownload(j.id)));
      const attachedIds = new Set(jobsToAttach.map((j) => j.id));
      readyJobs.value = readyJobs.value.filter((j) => !attachedIds.has(j.id));
    } else {
      for (const job of jobsToAttach) {
        const { bytes, filename, mime } = await fetchDownloadFile(job.id);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const dt = new DataTransfer();
        dt.items.add(new File([copy.buffer], filename, { type: mime }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await api.setChapterState([job.chapterId], 'uploaded');
        await api.deleteDownload(job.id);
        readyJobs.value = readyJobs.value.filter((j) => j.id !== job.id);
      }
    }
    notice.value = `Attached ${jobsToAttach.length} ZIP${jobsToAttach.length === 1 ? '' : 's'} to page`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function saveZipToDisk(job: DownloadJob) {
  busy.value = true;
  error.value = null;
  try {
    const { bytes, filename, mime } = await fetchDownloadFile(job.id);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy.buffer], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function markJobUploaded(job: DownloadJob) {
  busy.value = true;
  error.value = null;
  try {
    await api.setChapterState([job.chapterId], 'uploaded');
    await api.deleteDownload(job.id);
    readyJobs.value = readyJobs.value.filter((j) => j.id !== job.id);
    notice.value = `Marked ${job.chapterLabel} uploaded`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

let urlCheckTimer: ReturnType<typeof setInterval> | null = null;
let lastHref = location.href;

function checkUrlChange() {
  if (location.href !== lastHref) {
    lastHref = location.href;
    route.value = parseRoute(lastHref);
  }
}

onMounted(async () => {
  try {
    const stored = await chrome.storage?.local?.get(BOUNDS_KEY);
    const saved = stored?.[BOUNDS_KEY] as { x: number; y: number; width: number; height: number | null } | undefined;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number' && typeof saved.width === 'number') {
      dockBounds.value = clampBounds(saved);
    }
  } catch {
    /* ignore */
  }
  void loadRoute();
  window.addEventListener('popstate', checkUrlChange);
  window.addEventListener('resize', onWindowResize);
  urlCheckTimer = setInterval(checkUrlChange, 400);
});

onUnmounted(() => {
  window.removeEventListener('popstate', checkUrlChange);
  window.removeEventListener('resize', onWindowResize);
  if (urlCheckTimer) clearInterval(urlCheckTimer);
});

watch(route, () => void loadRoute());

useServerEvents((ev) => {
  if (route.value.kind === 'upload' && ev.type === 'job' && ev.job.state === 'done') {
    void loadUploads();
  } else if (ev.type === 'downloads_complete') {
    notice.value = `${ev.seriesTitle}: All ${ev.count} chapter${ev.count === 1 ? '' : 's'} downloaded!`;
    if (route.value.kind === 'upload') void loadUploads();
  }
});
</script>

<template>
  <template v-if="route.kind !== 'other'">
    <button v-if="collapsed" class="as-pill" @click="collapsed = false">
      <span class="as-wordmark">Atsu<span>Sync</span></span>
      <span class="as-dot" :class="{ off: !serverOnline }" />
    </button>

    <div v-else ref="dockEl" class="as-dock" :style="dockStyle">
    <div class="as-resize as-resize-w" @pointerdown="startResize('w', $event)" />
    <div class="as-resize as-resize-e" @pointerdown="startResize('e', $event)" />
    <div class="as-resize as-resize-s" @pointerdown="startResize('s', $event)" />
    <div class="as-resize as-resize-sw" @pointerdown="startResize('sw', $event)" />
    <div class="as-resize as-resize-se" @pointerdown="startResize('se', $event)" />

    <div class="as-header" :class="{ dragging }" @pointerdown="startDrag">
      <div class="as-brand">
        <span class="as-wordmark">Atsu<span>Sync</span></span>
        <span class="as-dot" :class="{ off: !serverOnline }" />
        <span v-if="route.kind === 'request'" class="as-badge indigo">Request</span>
        <span v-else-if="route.kind === 'manga'" class="as-badge indigo">Series</span>
        <span v-else-if="route.kind === 'upload'" class="as-badge green">Upload</span>
      </div>
      <div class="as-header-actions">
        <button class="as-btn icon" title="Open Side Panel (Tracked / Downloads)" @click="openSidePanel" aria-label="Open Side Panel"><Icon name="panel" /></button>
        <button class="as-btn icon" title="Minimize" @click="collapsed = true" aria-label="Minimize"><Icon name="minus" /></button>
      </div>
    </div>

    <div class="as-body">
      <div v-if="!serverOnline" class="as-error">
        AtsuSync server is offline. Start it with <code>npm start</code>, then reload.
      </div>
      <div v-if="error" class="as-error">{{ error }}</div>
      <div v-if="notice" class="as-ok">{{ notice }}</div>

      <!-- UPLOAD PAGE -->
      <template v-if="route.kind === 'upload'">
        <div class="as-row">
          <span class="as-title">Ready ZIPs ({{ visibleUploadJobs.length }})</span>
          <div class="as-row-wrap">
            <button v-if="visibleUploadJobs.length > 0" class="as-btn primary" :disabled="busy" @click="attachAllZipsToUploadPage">
              <Icon name="upload" /> Attach Zip All
            </button>
            <button v-if="route.mangaId" class="as-btn" @click="showAllUploads = !showAllUploads">
              {{ showAllUploads ? 'This manga' : 'Show all' }}
            </button>
          </div>
        </div>
        <div v-if="!visibleUploadJobs.length" class="as-card">
          <div class="as-muted">No completed chapter ZIPs waiting to upload.</div>
        </div>
        <div v-for="j in visibleUploadJobs" :key="j.id" class="as-card">
          <div class="as-title" :title="j.seriesTitle">{{ j.seriesTitle }}</div>
          <div class="as-muted">{{ j.chapterLabel }} · {{ j.sourceName }}</div>
          <div class="as-row-wrap">
            <button class="as-btn primary" :disabled="busy" @click="attachZipToUploadPage(j)"><Icon name="upload" /> Attach ZIP</button>
            <button class="as-btn" :disabled="busy" @click="saveZipToDisk(j)"><Icon name="download" /> Save</button>
            <button class="as-btn good" :disabled="busy" @click="markJobUploaded(j)"><Icon name="check" /> Mark uploaded</button>
          </div>
        </div>
      </template>

      <!-- MANGA PAGE NOT YET TRACKED -->
      <template v-else-if="route.kind === 'manga' && !requestData && serverOnline">
        <div class="as-card">
          <div class="as-muted">This series isn't tracked in AtsuSync yet.</div>
          <button class="as-btn primary" :disabled="busy" @click="trackCurrentManga"><Icon name="plus" /> Track in AtsuSync</button>
        </div>
      </template>

      <!-- REQUEST OR TRACKED MANGA -->
      <template v-else-if="requestData">
        <div class="as-card">
          <div class="as-title" :title="requestData.title">{{ requestData.title }}</div>
          <div class="as-row-wrap">
            <span class="as-badge">{{ requestData.status }}</span>
            <span v-if="requestData.presence?.verdict === 'on_atsu'" class="as-badge green">Already on Atsu</span>
            <span v-else-if="requestData.presence?.verdict === 'claimed'" class="as-badge amber">Claimed</span>
            <span v-else-if="requestData.presence?.verdict === 'possible'" class="as-badge amber">Possible match</span>
            <span v-if="mangabaka" class="as-badge indigo" :title="mangabaka.title">
              MB: {{ mangabaka.totalChapters ?? '?' }} ch<template v-if="mangabaka.status"> · {{ mangabaka.status }}</template>
            </span>
          </div>
          <div v-if="mbMismatch" class="as-warn">
            Linked MangaBaka entry is "{{ mangabaka?.type }}", which does not match this request's medium.
          </div>
          <div class="as-row-wrap">
            <button class="as-btn" :disabled="mbChecking" @click="checkMangaBaka">
              <Icon name="refresh" /> {{ mbChecking ? 'Checking MB…' : (mangabaka ? 'Refresh MB' : 'Check MangaBaka') }}
            </button>
            <a v-if="mangabaka?.url" class="as-btn" :href="mangabaka.url" target="_blank" rel="noopener noreferrer">
              <Icon name="external" /> MangaBaka<template v-if="mangabaka.type"> ({{ mangabaka.type }})</template>
            </a>
          </div>
        </div>

        <LinkSection v-for="l in links" :key="l.id" :link="l" @unlinked="loadRoute" @updated="loadRoute" />

        <div class="as-card">
          <div class="as-row">
            <span class="as-title">Sources</span>
            <button class="as-btn primary" :disabled="busy" @click="findSources">
              <Icon name="search" /> {{ busy ? 'Searching…' : 'Find sources' }}
            </button>
          </div>

          <div class="as-row">
            <input
              v-model="customSourceUrl"
              class="as-input"
              placeholder="Paste series URL from any supported site…"
              @keyup.enter="addCustomSource"
            />
            <button class="as-btn" :disabled="busy || !customSourceUrl.trim()" @click="addCustomSource"><Icon name="plus" /> Add</button>
          </div>

          <div v-for="m in matches" :key="m.seriesUrl" class="as-chap" style="align-items: center">
            <img
              v-if="m.cover && !brokenCovers.has(m.seriesUrl)"
              :src="m.cover"
              :alt="m.title"
              class="as-cover-thumb"
              loading="lazy"
              referrerpolicy="no-referrer"
              @error="markBrokenCover(m.seriesUrl)"
            />
            <div v-else class="as-cover-fallback" aria-hidden="true">
              <Icon name="book" />
            </div>
            <div style="flex: 1; min-width: 0">
              <div class="as-chap-name" :title="m.title">{{ m.title }}</div>
              <div class="as-muted">
                {{ m.sourceName }}
                <template v-if="m.chapterCount !== null"> · {{ m.chapterCount }} ch</template>
                <template v-if="m.error"> · {{ m.error }}</template>
              </div>
            </div>
            <a
              v-if="!m.seriesUrl.includes('#')"
              :href="m.seriesUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="as-btn icon"
              title="Open source"
              aria-label="Open source"
            >
              <Icon name="external" />
            </a>
            <button
              v-if="!links.some((l) => l.seriesUrl === m.seriesUrl)"
              class="as-btn primary"
              :disabled="busy"
              @click="linkSource(m)"
            >
              <Icon name="link" /> Link
            </button>
            <span v-else class="as-badge green">Linked</span>
          </div>
        </div>
      </template>
    </div>
  </div>
  </template>
</template>
