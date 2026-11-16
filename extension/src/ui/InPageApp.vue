<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { rankSourceMatches, type ContentRequest, type Link, type MangaBaka, type SourceMatch } from '@atsusync/shared';
import { api, getSidePanelState, START_SERVER_URL, toggleSidePanel, useServerEvents, waitForServerOnline } from '../api';
import LinkSection from './LinkSection.vue';
import Icon from './Icon.vue';
import { previewPublishedTitleReplace, replaceAllPublishedTitles, type PublishedTitlePreview } from './titleReplace';

type Route =
  | { kind: 'request'; postId: string }
  | { kind: 'manga'; mangaId: string }
  | { kind: 'upload'; mangaId: string | null; sourceId: string | null; mangaBakaId: string | null }
  | { kind: 'other' };

function parseRoute(href: string): Route {
  const u = new URL(href);
  const p = u.pathname;
  const reqMatch = p.match(/^\/social\/forum\/[^/]+\/content-requests\/([^/]+)\/?$/);
  if (reqMatch?.[1]) return { kind: 'request', postId: reqMatch[1] };
  const mangaMatch = p.match(/^\/manga\/([^/]+)\/?$/);
  if (mangaMatch?.[1]) return { kind: 'manga', mangaId: mangaMatch[1] };
  if (p === '/upload' || p.startsWith('/upload/')) {
    return {
      kind: 'upload',
      mangaId: u.searchParams.get('manga'),
      sourceId: u.searchParams.get('source'),
      mangaBakaId: u.searchParams.get('mb'),
    };
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

// Possible sources filtering & sorting
const sourceMatchFilter = ref('');
const sourceMatchSort = ref<'best' | 'chapters' | 'name'>('best');
const hideSourceErrors = ref(false);

const hasSourceErrors = computed(() => matches.value.some((m) => !!m.error));

const filteredMatches = computed(() => {
  const q = sourceMatchFilter.value.trim().toLowerCase();
  let list = matches.value.filter((m) => {
    if (hideSourceErrors.value && m.error) return false;
    if (!q) return true;
    return m.title.toLowerCase().includes(q) || m.sourceName.toLowerCase().includes(q);
  });
  const expected = mangabaka.value?.totalChapters ?? null;
  if (sourceMatchSort.value === 'best') {
    list = rankSourceMatches(list, expected);
  } else if (sourceMatchSort.value === 'chapters') {
    list = [...list].sort((a, b) => {
      const aErr = a.error ? 1 : 0;
      const bErr = b.error ? 1 : 0;
      if (aErr !== bErr) return aErr - bErr;
      const chDiff = (b.chapterCount ?? -1) - (a.chapterCount ?? -1);
      if (chDiff !== 0) return chDiff;
      return b.score - a.score;
    });
  } else {
    list = [...list].sort((a, b) => {
      const aErr = a.error ? 1 : 0;
      const bErr = b.error ? 1 : 0;
      if (aErr !== bErr) return aErr - bErr;
      if (b.score !== a.score) return b.score - a.score;
      return (b.chapterCount ?? -1) - (a.chapterCount ?? -1);
    });
  }
  return list;
});

// Published title mass replace state
const showTitleReplace = ref(false);
const findTitleText = ref('');
const replaceTitleText = ref('');
const replaceMatchCase = ref(false);
const replaceUseRegex = ref(false);
const titlePreview = ref<PublishedTitlePreview | null>(null);
const replaceRegexError = ref<string | null>(null);

function refreshTitlePreview() {
  if (route.value.kind !== 'upload' || !showTitleReplace.value) {
    titlePreview.value = null;
    replaceRegexError.value = null;
    return;
  }
  try {
    replaceRegexError.value = null;
    titlePreview.value = previewPublishedTitleReplace(findTitleText.value, replaceTitleText.value, {
      matchCase: replaceMatchCase.value,
      useRegex: replaceUseRegex.value,
    });
  } catch (e) {
    replaceRegexError.value = e instanceof Error ? e.message : String(e);
    titlePreview.value = null;
  }
}

watch([showTitleReplace, findTitleText, replaceTitleText, replaceMatchCase, replaceUseRegex], refreshTitlePreview);

function runMassTitleReplace() {
  if (!findTitleText.value) return;
  error.value = null;
  notice.value = null;
  try {
    const res = replaceAllPublishedTitles(findTitleText.value, replaceTitleText.value, {
      matchCase: replaceMatchCase.value,
      useRegex: replaceUseRegex.value,
    });
    if (res.totalInputs === 0) {
      error.value = 'No editable published title fields found on this page.';
    } else if (res.updatedInputs === 0) {
      notice.value = `No matches found across ${res.totalInputs} published title field${res.totalInputs === 1 ? '' : 's'}.`;
    } else {
      notice.value = `Replaced ${res.totalOccurrences} occurrence${res.totalOccurrences === 1 ? '' : 's'} across ${res.updatedInputs} title${res.updatedInputs === 1 ? '' : 's'}.`;
    }
    refreshTitlePreview();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

const activeId = computed(() => {
  if (requestData.value) return requestData.value.id;
  if (route.value.kind === 'request') return route.value.postId;
  if (route.value.kind === 'manga') return `atsu:${route.value.mangaId}`;
  return null;
});

function readUploadPageTitleHint(): string | null {
  const heading = document.querySelector('h1, h2, [class*="title"]')?.textContent?.trim();
  if (!heading || /^upload/i.test(heading)) return null;
  return heading;
}

let loadSeq = 0;

async function loadRoute() {
  const seq = ++loadSeq;
  error.value = null;
  notice.value = null;
  editingTitle.value = false;
  searching.value = false;
  searchingSources.value = [];
  sourceMatchFilter.value = '';
  requestData.value = null;
  mangabaka.value = null;
  mbMismatch.value = false;
  matches.value = [];
  brokenCovers.value = new Set();
  links.value = [];

  if (route.value.kind === 'upload') {
    if (route.value.sourceId || route.value.mangaId || route.value.mangaBakaId) {
      try {
        const res = await api.resolveUpload({
          sourceId: route.value.sourceId,
          mangaId: route.value.mangaId,
          mangaBakaId: route.value.mangaBakaId,
          title: readUploadPageTitleHint(),
        });
        if (seq !== loadSeq) return;
        serverOnline.value = true;
        if (res.request) {
          requestData.value = res.request;
          mangabaka.value = res.mangabaka;
          matches.value = res.matches;
          links.value = res.links;
        }
      } catch (e) {
        if (seq !== loadSeq) return;
        const err = e as Error & { status?: number };
        if (err.status === 0) serverOnline.value = false;
      }
    } else {
      try {
        await api.settings();
        if (seq !== loadSeq) return;
        serverOnline.value = true;
      } catch {
        if (seq !== loadSeq) return;
        serverOnline.value = false;
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
      if (seq !== loadSeq) return;
      serverOnline.value = true;
    } catch {
      if (seq !== loadSeq) return;
      serverOnline.value = false;
    }
    return;
  }

  try {
    const res = await api.request(lookupId);
    if (seq !== loadSeq) return;
    serverOnline.value = true;
    requestData.value = res.request;
    mangabaka.value = res.mangabaka;
    matches.value = res.matches;
    links.value = res.links;
  } catch (e) {
    if (seq !== loadSeq) return;
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
      matches.value = rankSourceMatches([...byUrl.values()], mangabaka.value?.totalChapters ?? null);
    }
  } else if (ev.type === 'discovery_done' && ev.requestId === activeId.value) {
    searching.value = false;
    searchingSources.value = [];
  } else if (ev.type === 'downloads_complete' && links.value.some((l) => l.id === ev.linkId)) {
    notice.value = `${ev.seriesTitle}: All ${ev.count} chapter${ev.count === 1 ? '' : 's'} downloaded!`;
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

      <!-- UPLOAD PAGE: Published Title Replace & unresolved hint -->
      <template v-if="route.kind === 'upload'">
        <div v-if="!requestData" class="as-card">
          <div class="as-muted">Open a tracked series upload page (from a tracked series) to manage and attach its ready downloads.</div>
        </div>

        <div class="as-card">
          <div class="as-row">
            <span class="as-title">Published Title Replace</span>
            <button class="as-btn sm" @click="showTitleReplace = !showTitleReplace">
              {{ showTitleReplace ? 'Hide' : 'Open' }}
            </button>
          </div>

          <template v-if="showTitleReplace">
            <input
              v-model="findTitleText"
              class="as-input"
              placeholder="Find text…"
              @keyup.enter="runMassTitleReplace"
            />
            <input
              v-model="replaceTitleText"
              class="as-input"
              placeholder="Replace with (leave empty to remove)…"
              @keyup.enter="runMassTitleReplace"
            />
            <div class="as-row">
              <div class="as-row-wrap">
                <label class="as-check-label">
                  <input v-model="replaceMatchCase" type="checkbox" />
                  <span>Match case</span>
                </label>
                <label class="as-check-label">
                  <input v-model="replaceUseRegex" type="checkbox" />
                  <span>Regex</span>
                </label>
              </div>
              <button class="as-btn icon sm" title="Rescan published titles" aria-label="Rescan published titles" @click="refreshTitlePreview">
                <Icon name="refresh" />
              </button>
            </div>

            <div v-if="replaceRegexError" class="as-error">{{ replaceRegexError }}</div>
            <div v-else-if="titlePreview" class="as-muted">
              {{ titlePreview.totalInputs }} title field{{ titlePreview.totalInputs === 1 ? '' : 's' }} found
              <template v-if="findTitleText">
                · {{ titlePreview.matchingInputs }} matching ({{ titlePreview.totalOccurrences }} occurrence{{ titlePreview.totalOccurrences === 1 ? '' : 's' }})
              </template>
            </div>

            <div v-if="titlePreview?.sample" class="as-chap" style="flex-direction: column; align-items: stretch; gap: 2px; padding: 8px 10px">
              <div class="as-muted" style="text-decoration: line-through; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="titlePreview.sample.before">
                {{ titlePreview.sample.before }}
              </div>
              <div class="as-chap-name" :title="titlePreview.sample.after">
                {{ titlePreview.sample.after || '(empty)' }}
              </div>
            </div>

            <button
              class="as-btn primary"
              :disabled="busy || !findTitleText || !!replaceRegexError || (titlePreview?.matchingInputs ?? 0) === 0"
              @click="runMassTitleReplace"
            >
              <Icon name="edit" /> Replace All
            </button>
          </template>
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

        <LinkSection
          v-for="l in links"
          :key="l.id"
          :link="l"
          :is-upload-page="route.kind === 'upload'"
          @unlinked="loadRoute"
          @updated="loadRoute"
        />

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

          <div v-if="matches.length > 0" class="as-row" style="gap: 6px">
            <input
              v-model="sourceMatchFilter"
              class="as-input"
              type="search"
              placeholder="Filter matches…"
              style="flex: 1; height: 30px; font-size: 12px"
            />
            <select
              v-model="sourceMatchSort"
              class="as-input"
              aria-label="Sort sources"
              style="width: auto; height: 30px; padding: 0 8px; font-size: 12px"
            >
              <option value="best">Best match</option>
              <option value="chapters">Most chapters</option>
              <option value="name">Close name</option>
            </select>
          </div>
          <label v-if="hasSourceErrors" class="as-check-label">
            <input v-model="hideSourceErrors" type="checkbox" />
            <span>Hide failed sources</span>
          </label>

          <div v-if="matches.length > 0 && !filteredMatches.length" class="as-muted">
            No sources match "{{ sourceMatchFilter }}".
          </div>

          <div v-for="m in filteredMatches" :key="m.seriesUrl" class="as-chap" style="align-items: center">
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
