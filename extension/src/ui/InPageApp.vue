<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ContentRequest, DownloadJob, Link, MangaBaka, SourceMatch } from '@atsusync/shared';
import { api, fetchDownloadFile, getSidePanelState, START_SERVER_URL, toggleSidePanel, useServerEvents, waitForServerOnline } from '../api';
import LinkSection from './LinkSection.vue';
import Icon from './Icon.vue';

type Route =
  | { kind: 'request'; postId: string }
  | { kind: 'manga'; mangaId: string }
  | { kind: 'upload'; mangaId: string | null; sourceId: string | null }
  | { kind: 'other' };

function parseRoute(href: string): Route {
  const u = new URL(href);
  const p = u.pathname;
  const reqMatch = p.match(/^\/social\/forum\/[^/]+\/content-requests\/([^/]+)\/?$/);
  if (reqMatch?.[1]) return { kind: 'request', postId: reqMatch[1] };
  const mangaMatch = p.match(/^\/manga\/([^/]+)\/?$/);
  if (mangaMatch?.[1]) return { kind: 'manga', mangaId: mangaMatch[1] };
  if (p === '/upload' || p.startsWith('/upload/')) {
    return { kind: 'upload', mangaId: u.searchParams.get('manga'), sourceId: u.searchParams.get('source') };
  }
  return { kind: 'other' };
}

const route = ref<Route>(parseRoute(location.href));
const collapsed = ref(false);
const closed = ref(false);
const sidePanelOpen = ref(false);
const serverOnline = ref(true);
const starting = ref(false);
const busy = ref(false);
let startAbort: AbortController | null = null;
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

// Title editing state (content request)
const editingTitle = ref(false);
const titleDraft = ref('');

// Live source discovery state
const searching = ref(false);
const searchingSources = ref<{ id: string; name: string }[]>([]);
const searchTotal = ref(0);
const searchDone = ref(0);

// Dock & pill position/size (persisted in chrome.storage.local)
const BOUNDS_KEY = 'atsusync_dock_bounds';
const PILL_KEY = 'atsusync_pill_pos';
const CLOSED_KEY = 'atsusync_dock_closed';
const MIN_W = 280;
const MIN_H = 220;
const dockEl = ref<HTMLElement | null>(null);
const dockBounds = ref<{ x: number; y: number; width: number; height: number | null }>({
  x: Math.max(12, window.innerWidth - 380 - 16),
  y: 88,
  width: 380,
  height: null,
});
const pillPos = ref<{ x: number; y: number }>({
  x: Math.max(12, window.innerWidth - 130),
  y: 88,
});
const dragging = ref(false);
const pillDragging = ref(false);

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

function clampPill(p: { x: number; y: number }) {
  return {
    x: Math.min(Math.max(8, p.x), Math.max(8, window.innerWidth - 120)),
    y: Math.min(Math.max(8, p.y), Math.max(8, window.innerHeight - 48)),
  };
}

function savePillPos() {
  try {
    void chrome.storage?.local?.set({ [PILL_KEY]: pillPos.value });
  } catch {
    /* ignore */
  }
}

function setClosed(val: boolean) {
  closed.value = val;
  try {
    void chrome.storage?.local?.set({ [CLOSED_KEY]: val });
  } catch {
    /* ignore */
  }
}

const pillStyle = computed(() => ({
  left: `${pillPos.value.x}px`,
  top: `${pillPos.value.y}px`,
  right: 'auto',
}));

function startPillDrag(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  const origX = pillPos.value.x;
  const origY = pillPos.value.y;
  let moved = false;
  pillDragging.value = true;

  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (moved) {
      pillPos.value = clampPill({ x: origX + dx, y: origY + dy });
    }
  };
  const onUp = () => {
    pillDragging.value = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (moved) {
      savePillPos();
    } else {
      collapsed.value = false;
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
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
  pillPos.value = clampPill(pillPos.value);
}

function markBrokenCover(url: string) {
  const next = new Set(brokenCovers.value);
  next.add(url);
  brokenCovers.value = next;
}

// Upload state
const allJobs = ref<DownloadJob[]>([]);
const readyJobs = computed(() => allJobs.value.filter((j) => j.state === 'done'));
const activeJobs = computed(() => allJobs.value.filter((j) => j.state === 'queued' || j.state === 'downloading'));
const showAllUploads = ref(false);
const autoUpload = ref(false);
let attachingAuto = false;

const activeId = computed(() => {
  if (requestData.value) return requestData.value.id;
  if (route.value.kind === 'request') return route.value.postId;
  if (route.value.kind === 'manga') return `atsu:${route.value.mangaId}`;
  return null;
});

function matchesCurrentUploadSeries(j: DownloadJob): boolean {
  if (route.value.kind !== 'upload') return false;
  if (links.value.some((l) => l.id === j.linkId)) return true;
  if (route.value.mangaId && j.uploadUrl.includes(`manga=${route.value.mangaId}`)) return true;
  if (requestData.value?.atsuMangaId && j.uploadUrl.includes(`manga=${requestData.value.atsuMangaId}`)) return true;
  return false;
}

const isSeriesUploadPage = computed(() => route.value.kind === 'upload' && !!(route.value.mangaId || route.value.sourceId));

const visibleUploadJobs = computed(() => {
  if (route.value.kind !== 'upload') return [];
  if (!isSeriesUploadPage.value || showAllUploads.value) return readyJobs.value;
  const filtered = readyJobs.value.filter(matchesCurrentUploadSeries);
  return filtered.length ? filtered : isSeriesUploadPage.value && requestData.value ? [] : readyJobs.value;
});

const visibleActiveJobs = computed(() => {
  if (route.value.kind !== 'upload') return [];
  if (!isSeriesUploadPage.value || showAllUploads.value) return activeJobs.value;
  return activeJobs.value.filter(matchesCurrentUploadSeries);
});

function readUploadPageTitleHint(): string | null {
  const heading = document.querySelector('h1, h2, [class*="title"]')?.textContent?.trim();
  if (!heading || /^upload/i.test(heading)) return null;
  return heading;
}

async function loadRoute() {
  error.value = null;
  notice.value = null;
  editingTitle.value = false;
  searching.value = false;
  searchingSources.value = [];
  requestData.value = null;
  mangabaka.value = null;
  mbMismatch.value = false;
  matches.value = [];
  brokenCovers.value = new Set();
  links.value = [];

  if (route.value.kind === 'upload') {
    await loadUploads();
    if (route.value.sourceId || route.value.mangaId) {
      try {
        const res = await api.resolveUpload({
          sourceId: route.value.sourceId,
          mangaId: route.value.mangaId,
          title: readUploadPageTitleHint(),
        });
        serverOnline.value = true;
        if (res.request) {
          requestData.value = res.request;
          mangabaka.value = res.mangabaka;
          matches.value = res.matches;
          links.value = res.links;
        }
      } catch (e) {
        const err = e as Error & { status?: number };
        if (err.status === 0) serverOnline.value = false;
      }
    }
    return;
  }
  const lookupId =
    route.value.kind === 'request'
      ? route.value.postId
      : route.value.kind === 'manga'
        ? `atsu:${route.value.mangaId}`
        : null;

  if (!lookupId) {
    try {
      await api.settings();
      serverOnline.value = true;
    } catch {
      serverOnline.value = false;
    }
    return;
  }

  try {
    const res = await api.request(lookupId);
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
    allJobs.value = all;
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 0) serverOnline.value = false;
    error.value = err.message;
  }
}

function startEditTitle() {
  if (!requestData.value) return;
  titleDraft.value = requestData.value.title;
  editingTitle.value = true;
}

async function saveTitleOverride(title: string | null) {
  if (!requestData.value) return;
  busy.value = true;
  error.value = null;
  try {
    requestData.value = await api.updateRequestTitle(requestData.value.id, title);
    editingTitle.value = false;
    notice.value = title ? 'Post title updated' : 'Post title reset';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
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
    allJobs.value = allJobs.value.filter((j) => j.id !== job.id);
    notice.value = `Attached ${filename} to page`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function attachAllZipsToUploadPage() {
  const jobsToAttach = [...visibleUploadJobs.value];
  if (!jobsToAttach.length || attachingAuto) return;
  attachingAuto = true;
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
      const attachedIds = new Set(jobsToAttach.map((j) => j.id));
      allJobs.value = allJobs.value.filter((j) => !attachedIds.has(j.id));
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
        allJobs.value = allJobs.value.filter((j) => j.id !== job.id);
      }
    }
    notice.value = `Attached ${jobsToAttach.length} ZIP${jobsToAttach.length === 1 ? '' : 's'} to page`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
    attachingAuto = false;
  }
}

async function maybeAutoAttach() {
  if (!autoUpload.value || route.value.kind !== 'upload') return;
  if (visibleUploadJobs.value.length > 0 && visibleActiveJobs.value.length === 0) {
    await attachAllZipsToUploadPage();
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

let urlCheckTimer: ReturnType<typeof setInterval> | null = null;
let lastHref = location.href;

function checkUrlChange() {
  if (location.href !== lastHref) {
    lastHref = location.href;
    route.value = parseRoute(lastHref);
  }
}

function onRuntimeMessage(msg: unknown) {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as { type?: string; open?: boolean };
  if (m.type === 'summonDock') {
    setClosed(false);
    collapsed.value = false;
    void loadRoute();
  } else if (m.type === 'sidePanelState' && typeof m.open === 'boolean') {
    sidePanelOpen.value = m.open;
  }
}

onMounted(async () => {
  try {
    const stored = await chrome.storage?.local?.get([BOUNDS_KEY, PILL_KEY, CLOSED_KEY]);
    const saved = stored?.[BOUNDS_KEY] as { x: number; y: number; width: number; height: number | null } | undefined;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number' && typeof saved.width === 'number') {
      dockBounds.value = clampBounds(saved);
    }
    const savedPill = stored?.[PILL_KEY] as { x: number; y: number } | undefined;
    if (savedPill && typeof savedPill.x === 'number' && typeof savedPill.y === 'number') {
      pillPos.value = clampPill(savedPill);
    }
    if (typeof stored?.[CLOSED_KEY] === 'boolean') {
      closed.value = stored[CLOSED_KEY] as boolean;
    }
  } catch {
    /* ignore */
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  void getSidePanelState().then((open) => (sidePanelOpen.value = open));
  void loadRoute();
  window.addEventListener('popstate', checkUrlChange);
  window.addEventListener('resize', onWindowResize);
  urlCheckTimer = setInterval(checkUrlChange, 400);
});

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  window.removeEventListener('popstate', checkUrlChange);
  window.removeEventListener('resize', onWindowResize);
  if (urlCheckTimer) clearInterval(urlCheckTimer);
  startAbort?.abort();
});

async function handleStartServer() {
  if (starting.value) return;
  starting.value = true;
  startAbort?.abort();
  startAbort = new AbortController();
  const isUp = await waitForServerOnline(startAbort.signal);
  starting.value = false;
  if (isUp && !startAbort.signal.aborted) {
    serverOnline.value = true;
    await loadRoute();
  }
}

watch(route, () => void loadRoute());
watch(autoUpload, (on) => {
  if (on) void maybeAutoAttach();
});

useServerEvents((ev) => {
  if (ev.type === 'discovery_start' && ev.requestId === activeId.value) {
    searching.value = true;
    searchingSources.value = ev.sources;
    searchTotal.value = ev.sources.length;
    searchDone.value = 0;
    matches.value = [];
  } else if (ev.type === 'discovery_progress' && ev.requestId === activeId.value) {
    searchDone.value += 1;
    searchingSources.value = searchingSources.value.filter((s) => s.id !== ev.sourceId);
    if (ev.matches.length > 0) {
      const byUrl = new Map(matches.value.map((m) => [m.seriesUrl, m]));
      for (const m of ev.matches) byUrl.set(m.seriesUrl, m);
      matches.value = [...byUrl.values()].sort((a, b) => b.score - a.score);
    }
  } else if (ev.type === 'discovery_done' && ev.requestId === activeId.value) {
    searching.value = false;
    searchingSources.value = [];
  } else if (route.value.kind === 'upload' && ev.type === 'job') {
    const idx = allJobs.value.findIndex((j) => j.id === ev.job.id);
    if (idx >= 0) allJobs.value[idx] = ev.job;
    else allJobs.value.unshift(ev.job);
    if (ev.job.state === 'done') {
      void loadUploads().then(() => maybeAutoAttach());
    }
  } else if (ev.type === 'downloads_complete') {
    notice.value = `${ev.seriesTitle}: All ${ev.count} chapter${ev.count === 1 ? '' : 's'} downloaded!`;
    if (route.value.kind === 'upload') {
      void loadUploads().then(() => maybeAutoAttach());
    }
  }
});
</script>

<template>
  <template v-if="route.kind !== 'other' && !closed">
    <button
      v-if="collapsed"
      class="as-pill"
      :class="{ off: !serverOnline, dragging: pillDragging }"
      :style="pillStyle"
      @pointerdown="startPillDrag"
    >
      <span class="as-wordmark">Atsu<span>Sync</span></span>
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
        <span v-if="!serverOnline" class="as-badge red">Offline</span>
        <span v-else-if="route.kind === 'request'" class="as-badge indigo">Request</span>
        <span v-else-if="route.kind === 'manga'" class="as-badge indigo">Series</span>
        <span v-else-if="route.kind === 'upload'" class="as-badge green">Upload</span>
      </div>
      <div class="as-header-actions">
        <button
          class="as-btn icon"
          :title="sidePanelOpen ? 'Collapse Side Panel' : 'Open Side Panel'"
          :aria-label="sidePanelOpen ? 'Collapse Side Panel' : 'Open Side Panel'"
          @click="toggleSidePanel"
        >
          <Icon :name="sidePanelOpen ? 'panelOpen' : 'panel'" />
        </button>
        <button class="as-btn icon" title="Minimize" @click="collapsed = true" aria-label="Minimize"><Icon name="minus" /></button>
        <button class="as-btn icon" title="Close" @click="setClosed(true)" aria-label="Close"><Icon name="x" /></button>
      </div>
    </div>

    <div class="as-body">
      <div v-if="!serverOnline" class="as-offline-screen">
        <a
          :href="START_SERVER_URL"
          class="as-start-btn"
          :class="{ starting }"
          :aria-disabled="starting"
          @click="starting ? $event.preventDefault() : handleStartServer()"
        >
          <Icon :name="starting ? 'refresh' : 'power'" :class="{ 'as-spin': starting }" />
          <span>{{ starting ? 'Starting Server…' : 'Start Server' }}</span>
        </a>
      </div>

      <template v-else>
      <div v-if="error" class="as-error">{{ error }}</div>
      <div v-if="notice" class="as-ok">{{ notice }}</div>

      <!-- UPLOAD PAGE: Ready ZIPs & Auto-Attach -->
      <template v-if="route.kind === 'upload'">
        <div class="as-card">
          <div class="as-row">
            <span class="as-title">Ready ZIPs ({{ visibleUploadJobs.length }})</span>
            <div class="as-row-wrap">
              <button v-if="visibleUploadJobs.length > 0" class="as-btn primary sm" :disabled="busy" @click="attachAllZipsToUploadPage">
                <Icon name="upload" /> Attach Zip All
              </button>
              <button v-if="isSeriesUploadPage" class="as-btn sm" @click="showAllUploads = !showAllUploads">
                {{ showAllUploads ? 'This series' : 'Show all' }}
              </button>
            </div>
          </div>
          <label class="as-check-label">
            <input v-model="autoUpload" type="checkbox" />
            <span>Upload when downloaded</span>
          </label>
          <div v-if="visibleActiveJobs.length" class="as-muted">
            Downloading {{ visibleActiveJobs.length }} chapter{{ visibleActiveJobs.length === 1 ? '' : 's' }}…
          </div>
          <div v-if="!visibleUploadJobs.length && !visibleActiveJobs.length" class="as-muted">
            No completed chapter ZIPs waiting to upload.
          </div>
          <div v-for="j in visibleUploadJobs" :key="j.id" class="as-chap" style="flex-direction: column; align-items: stretch; gap: 6px; padding: 8px 10px">
            <div class="as-row">
              <div style="min-width: 0">
                <div class="as-chap-name" :title="j.seriesTitle">{{ j.seriesTitle }}</div>
                <div class="as-muted">{{ j.chapterLabel }} · {{ j.sourceName }}</div>
              </div>
              <div class="as-row-wrap">
                <button class="as-btn primary sm" :disabled="busy" @click="attachZipToUploadPage(j)"><Icon name="upload" /> Attach</button>
                <button class="as-btn sm" :disabled="busy" @click="saveZipToDisk(j)"><Icon name="download" /> Save</button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- MANGA PAGE NOT YET TRACKED -->
      <template v-if="route.kind === 'manga' && !requestData && serverOnline">
        <div class="as-card">
          <div class="as-muted">This series isn't tracked in AtsuSync yet.</div>
          <button class="as-btn primary" :disabled="busy" @click="trackCurrentManga"><Icon name="plus" /> Track in AtsuSync</button>
        </div>
      </template>

      <!-- REQUEST, TRACKED MANGA, OR RESOLVED UPLOAD SERIES -->
      <template v-if="requestData">
        <div class="as-card">
          <div v-if="!editingTitle" class="as-row">
            <div class="as-title" :title="requestData.title">{{ requestData.title }}</div>
            <button
              v-if="route.kind === 'request'"
              class="as-btn icon sm"
              title="Overwrite post title"
              aria-label="Overwrite post title"
              @click="startEditTitle"
            >
              <Icon name="edit" />
            </button>
          </div>
          <div v-else class="as-card" style="padding: 0; gap: 6px">
            <input
              v-model="titleDraft"
              class="as-input"
              placeholder="Enter series title…"
              @keyup.enter="saveTitleOverride(titleDraft)"
              @keyup.escape="editingTitle = false"
            />
            <div class="as-row-wrap">
              <button class="as-btn primary sm" :disabled="busy" @click="saveTitleOverride(titleDraft)">Save</button>
              <button v-if="requestData.customTitle" class="as-btn sm" :disabled="busy" @click="saveTitleOverride(null)">Reset</button>
              <button class="as-btn sm" @click="editingTitle = false">Cancel</button>
            </div>
          </div>

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
            <button class="as-btn primary" :disabled="busy || searching" @click="findSources">
              <Icon name="search" /> {{ searching ? `Searching (${searchDone}/${searchTotal})…` : 'Find sources' }}
            </button>
          </div>

          <template v-if="searching">
            <div class="as-progress">
              <div class="as-progress-bar" :style="{ width: `${searchTotal ? Math.round((searchDone / searchTotal) * 100) : 0}%` }" />
            </div>
            <div v-if="searchingSources.length" class="as-source-chips">
              <span v-for="s in searchingSources" :key="s.id" class="as-source-chip">{{ s.name }}</span>
            </div>
          </template>

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
      </template>
    </div>
  </div>
  </template>
</template>
