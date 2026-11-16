<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  DEFAULT_SOURCE_SEARCH_FILTER,
  SOURCE_FILTER_OPTIONS,
  rankSourceMatches,
  type AtsuSeriesInfo,
  type ContentRequest,
  type Link,
  type MangaBaka,
  type SourceMatch,
  type SourceSearchFilter,
} from '@atsusync/shared';
import { api, getSidePanelState, START_SERVER_URL, toggleSidePanel, useCoverResolver, useServerEvents, waitForServerOnline } from '../api';
import AlertBanner from './AlertBanner.vue';
import LinkSection from './LinkSection.vue';
import Icon from './Icon.vue';
import ToolsWindow from './ToolsWindow.vue';

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
const dockOpen = computed(() => route.value.kind !== 'other' && !closed.value && !collapsed.value);
const sidePanelOpen = ref(false);
const serverOnline = ref(true);
const starting = ref(false);
const busy = ref(false);
const loadingRoute = ref(false);
let startAbort: AbortController | null = null;
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

watch(notice, (val) => {
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  if (val) {
    noticeTimer = setTimeout(() => {
      notice.value = null;
      noticeTimer = null;
    }, 4500);
  }
});

// Request / Manga state
const requestData = ref<ContentRequest | null>(null);
const mangabaka = ref<MangaBaka | null>(null);
const atsuSeries = ref<AtsuSeriesInfo | null>(null);
const seriesCollapsed = ref(false);
const descExpanded = ref(false);
const mbMismatch = ref(false);
const mbChecking = ref(false);
const matches = ref<SourceMatch[]>([]);
const brokenCovers = ref(new Set<string>());
const { coverSrc, preload: preloadCovers, reset: resetCovers } = useCoverResolver();
const links = ref<Link[]>([]);

function formatLabel(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const seriesCover = computed(() => mangabaka.value?.cover ?? requestData.value?.cover ?? atsuSeries.value?.cover ?? null);

watch([matches, seriesCover], ([list, sc]) => {
  preloadCovers([sc, ...list.map((m) => m.cover)]);
}, { immediate: true });

const seriesDescription = computed(() => {
  const fromMb = mangabaka.value?.description?.trim();
  if (fromMb) return fromMb;
  const fromAtsu = atsuSeries.value?.synopsis?.trim();
  if (fromAtsu) return fromAtsu;
  const fromReq = requestData.value?.content?.trim();
  if (fromReq && !/^https?:\/\/\S+$/i.test(fromReq)) return fromReq;
  return null;
});

const seriesAtsuId = computed(
  () => atsuSeries.value?.id ?? requestData.value?.atsuMangaId ?? requestData.value?.presence?.match?.mangaId ?? null,
);

const seriesAtsuChapters = computed(() => {
  if (atsuSeries.value) return atsuSeries.value.chapterCount;
  const m = requestData.value?.presence?.match;
  if (m && (m.chapterCount > 0 || requestData.value?.presence?.verdict === 'on_atsu')) return m.chapterCount;
  return null;
});

const seriesAtsuUrl = computed(() => (seriesAtsuId.value ? `https://atsu.moe/manga/${seriesAtsuId.value}` : null));
const showOpenOnAtsu = computed(
  () => !!seriesAtsuUrl.value && !(route.value.kind === 'manga' && route.value.mangaId === seriesAtsuId.value),
);

const requestStatusLabel = computed(() => {
  const s = requestData.value?.status;
  if (!s) return '';
  if (s === 'cant_add') return "Can't add";
  if (s === 'looking') return 'Looking into it';
  return formatLabel(s);
});

const requestStatusBadgeClass = computed(() => {
  switch (requestData.value?.status) {
    case 'added':
      return 'green';
    case 'cant_add':
    case 'duplicate':
      return 'red';
    case 'queued':
    case 'looking':
      return 'amber';
    default:
      return '';
  }
});

const mbStatusBadgeClass = computed(() => {
  switch (mangabaka.value?.status?.toLowerCase()) {
    case 'completed':
      return 'green';
    case 'releasing':
    case 'ongoing':
      return 'indigo';
    case 'hiatus':
      return 'amber';
    case 'cancelled':
    case 'discontinued':
      return 'red';
    default:
      return '';
  }
});

const seriesMetaLine = computed(() => {
  const parts: string[] = [];
  const type = mangabaka.value?.type ?? atsuSeries.value?.medium ?? null;
  if (type) parts.push(formatLabel(type));
  if (mangabaka.value?.year) parts.push(String(mangabaka.value.year));
  if (mangabaka.value?.authors?.length) parts.push(mangabaka.value.authors.slice(0, 2).join(', '));
  if (mangabaka.value?.rating != null) parts.push(`★ ${Math.round(mangabaka.value.rating)}%`);
  return parts.join(' · ');
});

const seriesGenres = computed(() => (mangabaka.value?.genres ?? []).slice(0, 5).map(formatLabel));

const STATUS_TAG_NAMES = new Set(['open', 'queued', 'looking into it', 'added', "can't add", 'duplicate']);
const requestExtraTags = computed(() =>
  (requestData.value?.tags ?? []).filter((t) => !STATUS_TAG_NAMES.has(t.name.trim().toLowerCase())),
);

// Title editing state (content request)
const editingTitle = ref(false);
const titleDraft = ref('');

// Live source discovery state
const searching = ref(false);
const searchingSources = ref<{ id: string; name: string }[]>([]);
const searchTotal = ref(0);
const searchDone = ref(0);

// Source search filter (persisted in chrome.storage.local; all checked by default)
const SOURCE_FILTER_KEY = 'atsusync_source_filter';
const sourceFilter = ref<SourceSearchFilter>({ ...DEFAULT_SOURCE_SEARCH_FILTER });
const sourceFilterOpen = ref(false);
const sourceFilterWrapEl = ref<HTMLElement | null>(null);
const bodyEl = ref<HTMLElement | null>(null);

function onDockWheel(e: WheelEvent) {
  if (e.ctrlKey) return;
  e.stopPropagation();

  const el = bodyEl.value;
  if (!el || el.scrollHeight <= el.clientHeight) {
    e.preventDefault();
    return;
  }

  const target = e.target as Node | null;
  if (!target || !el.contains(target)) {
    e.preventDefault();
    return;
  }

  // Let native browser smooth scrolling handle .as-body; only block at boundaries
  // so wheel events don't chain to the underlying page.
  const dy = e.deltaY;
  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  if ((dy < 0 && atTop) || (dy > 0 && atBottom)) {
    e.preventDefault();
  }
}
const activeFilterCount = computed(() => SOURCE_FILTER_OPTIONS.filter((o) => sourceFilter.value[o.key]).length);
const isSourceFiltered = computed(() => activeFilterCount.value < SOURCE_FILTER_OPTIONS.length);
const hasAnyKindSelected = computed(
  () =>
    sourceFilter.value.keiyoushi ||
    sourceFilter.value.lncrawl ||
    sourceFilter.value.lnreader ||
    sourceFilter.value.aggregators ||
    sourceFilter.value.scanlations ||
    sourceFilter.value.official,
);

// Dock & pill position/size (persisted in chrome.storage.local)
const BOUNDS_KEY = 'atsusync_dock_bounds';
const PILL_KEY = 'atsusync_pill_pos';
const CLOSED_KEY = 'atsusync_dock_closed';
const TOOLS_OPEN_KEY = 'atsusync_tools_open';
const toolsOpen = ref(false);
const MIN_W = 340;
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

function setToolsOpen(val: boolean) {
  toolsOpen.value = val;
  try {
    void chrome.storage?.local?.set({ [TOOLS_OPEN_KEY]: val });
  } catch {
    /* ignore */
  }
}

function toggleTools() {
  setToolsOpen(!toolsOpen.value);
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
    ...(b.height !== null
      ? { height: `${b.height}px` }
      : { height: 'auto', maxHeight: `${Math.max(MIN_H, window.innerHeight - b.y - 16)}px` }),
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
    let { x, y, width, height } = orig;

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
const SOURCE_SORT_OPTIONS: { value: 'best' | 'chapters' | 'name'; label: string }[] = [
  { value: 'best', label: 'Best match' },
  { value: 'chapters', label: 'Most chapters' },
  { value: 'name', label: 'Close name' },
];
const sourcesCollapsed = ref(false);
const sourceMatchFilter = ref('');
const sourceMatchSort = ref<'best' | 'chapters' | 'name'>('best');
const sourceSortOpen = ref(false);
const sourceSortWrapEl = ref<HTMLElement | null>(null);
const sourceSortLabel = computed(
  () => SOURCE_SORT_OPTIONS.find((o) => o.value === sourceMatchSort.value)?.label ?? 'Best match',
);

const filteredMatches = computed(() => {
  const q = sourceMatchFilter.value.trim().toLowerCase();
  let list = matches.value.filter((m) => {
    if (m.error) return false;
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
  busy.value = false;
  mbChecking.value = false;
  error.value = null;
  notice.value = null;
  editingTitle.value = false;
  searching.value = false;
  searchingSources.value = [];
  sourceMatchFilter.value = '';
  sourceSortOpen.value = false;
  requestData.value = null;
  mangabaka.value = null;
  atsuSeries.value = null;
  descExpanded.value = false;
  mbMismatch.value = false;
  matches.value = [];
  brokenCovers.value = new Set();
  resetCovers();
  links.value = [];

  if (route.value.kind === 'upload') {
    if (route.value.sourceId || route.value.mangaId || route.value.mangaBakaId) {
      loadingRoute.value = true;
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
          atsuSeries.value = res.atsuSeries ?? null;
          matches.value = res.matches;
          links.value = res.links;
        }
      } catch (e) {
        if (seq !== loadSeq) return;
        const err = e as Error & { status?: number };
        if (err.status === 0) serverOnline.value = false;
      } finally {
        if (seq === loadSeq) loadingRoute.value = false;
      }
    } else {
      loadingRoute.value = false;
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
    loadingRoute.value = false;
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

  loadingRoute.value = true;
  try {
    const res = await api.request(lookupId);
    if (seq !== loadSeq) return;
    serverOnline.value = true;
    requestData.value = res.request;
    mangabaka.value = res.mangabaka;
    atsuSeries.value = res.atsuSeries ?? null;
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
  } finally {
    if (seq === loadSeq) loadingRoute.value = false;
  }
}

async function checkMangaBaka() {
  if (!activeId.value) return;
  const seq = loadSeq;
  mbChecking.value = true;
  error.value = null;
  try {
    const res = await api.checkMangaBaka(activeId.value);
    if (seq !== loadSeq) return;
    mangabaka.value = res.mangabaka;
    mbMismatch.value = res.mediumMismatch;
    if (!res.mangabaka) {
      notice.value = 'No matching MangaBaka entry found for this medium';
    }
  } catch (e) {
    if (seq !== loadSeq) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === loadSeq) mbChecking.value = false;
  }
}

function startEditTitle() {
  if (!requestData.value) return;
  titleDraft.value = requestData.value.title;
  editingTitle.value = true;
}

async function saveTitleOverride(title: string | null) {
  if (!requestData.value) return;
  const seq = loadSeq;
  busy.value = true;
  error.value = null;
  try {
    const updated = await api.updateRequestTitle(requestData.value.id, title);
    if (seq !== loadSeq) return;
    requestData.value = updated;
    editingTitle.value = false;
    notice.value = title ? 'Post title updated' : 'Post title reset';
  } catch (e) {
    if (seq !== loadSeq) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === loadSeq) busy.value = false;
  }
}

const canUntrack = computed(
  () => !!requestData.value && (route.value.kind === 'manga' || requestData.value.id.startsWith('atsu:')),
);

async function trackCurrentManga() {
  if (route.value.kind !== 'manga') return;
  const seq = loadSeq;
  busy.value = true;
  error.value = null;
  try {
    await api.addSeries(location.href);
    if (seq !== loadSeq) return;
    await loadRoute();
  } catch (e) {
    if (seq !== loadSeq) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === loadSeq) busy.value = false;
  }
}

async function untrackCurrentSeries() {
  if (!requestData.value || busy.value) return;
  const seq = loadSeq;
  busy.value = true;
  error.value = null;
  try {
    await api.deleteRequest(requestData.value.id);
    if (seq !== loadSeq) return;
    requestData.value = null;
    mangabaka.value = null;
    atsuSeries.value = null;
    matches.value = [];
    links.value = [];
    descExpanded.value = false;
    mbMismatch.value = false;
  } catch (e) {
    if (seq !== loadSeq) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === loadSeq) busy.value = false;
  }
}

let findStopped = false;

async function findSources() {
  if (!activeId.value || !hasAnyKindSelected.value) return;
  sourceFilterOpen.value = false;
  sourcesCollapsed.value = false;
  const seq = loadSeq;
  findStopped = false;
  searching.value = true;
  busy.value = true;
  error.value = null;
  try {
    const found = await api.findSources(activeId.value, { ...sourceFilter.value });
    if (seq !== loadSeq) return;
    if (!findStopped) {
      matches.value = found;
    }
  } catch (e) {
    if (seq !== loadSeq) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === loadSeq) {
      busy.value = false;
      searching.value = false;
      searchingSources.value = [];
    }
  }
}

async function stopFindSources() {
  if (!activeId.value) return;
  findStopped = true;
  searching.value = false;
  searchingSources.value = [];
  busy.value = false;
  try {
    await api.stopFindSources(activeId.value);
  } catch {
    /* ignore */
  }
}

async function linkSource(m: SourceMatch) {
  if (!activeId.value || busy.value) return;
  const seq = loadSeq;
  busy.value = true;
  error.value = null;
  try {
    const created = await api.createLink(activeId.value, m.sourceId, m.seriesUrl);
    if (seq !== loadSeq) return;
    links.value = [...links.value.filter((l) => l.id !== created.id), created];
  } catch (e) {
    if (seq !== loadSeq) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === loadSeq) busy.value = false;
  }
}

function onLinkUnlinked(linkId: number) {
  links.value = links.value.filter((l) => l.id !== linkId);
}

async function refreshLinks() {
  if (!activeId.value) return;
  const seq = loadSeq;
  try {
    const res = await api.request(activeId.value);
    if (seq !== loadSeq) return;
    requestData.value = res.request;
    atsuSeries.value = res.atsuSeries ?? null;
    links.value = res.links;
  } catch {
    /* ignore transient background refresh errors */
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

function onRuntimeMessage(
  msg: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as { type?: string; open?: boolean };
  if (m.type === 'summonDock') {
    setClosed(false);
    collapsed.value = false;
    void loadRoute();
    sendResponse({ open: dockOpen.value });
  } else if (m.type === 'toggleDock') {
    if (dockOpen.value) {
      setClosed(true);
    } else {
      setClosed(false);
      collapsed.value = false;
      void loadRoute();
    }
    sendResponse({ open: dockOpen.value });
  } else if (m.type === 'getDockState') {
    sendResponse({ open: dockOpen.value, toolsOpen: toolsOpen.value });
  } else if (m.type === 'summonTools') {
    setToolsOpen(true);
    sendResponse({ open: toolsOpen.value });
  } else if (m.type === 'toggleTools') {
    toggleTools();
    sendResponse({ open: toolsOpen.value });
  } else if (m.type === 'getToolsState') {
    sendResponse({ open: toolsOpen.value });
  } else if (m.type === 'sidePanelState' && typeof m.open === 'boolean') {
    sidePanelOpen.value = m.open;
  }
}

watch(dockOpen, (open) => {
  try {
    void chrome.runtime.sendMessage({ type: 'dockState', open }).catch(() => {});
  } catch {
    /* ignore */
  }
});

watch(toolsOpen, (open) => {
  try {
    void chrome.runtime.sendMessage({ type: 'toolsState', open }).catch(() => {});
  } catch {
    /* ignore */
  }
});

function onDocPointerDown(e: PointerEvent) {
  const path = e.composedPath();
  if (sourceFilterOpen.value) {
    const wrap = sourceFilterWrapEl.value;
    if (wrap && !path.includes(wrap)) {
      sourceFilterOpen.value = false;
    }
  }
  if (sourceSortOpen.value) {
    const wrap = sourceSortWrapEl.value;
    if (wrap && !path.includes(wrap)) {
      sourceSortOpen.value = false;
    }
  }
}

function onDocKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    sourceFilterOpen.value = false;
    sourceSortOpen.value = false;
  }
}

watch(
  sourceFilter,
  (val) => {
    try {
      void chrome.storage?.local?.set({ [SOURCE_FILTER_KEY]: { ...val } });
    } catch {
      /* ignore */
    }
  },
  { deep: true },
);

onMounted(async () => {
  try {
    const stored = await chrome.storage?.local?.get([BOUNDS_KEY, PILL_KEY, CLOSED_KEY, TOOLS_OPEN_KEY, SOURCE_FILTER_KEY]);
    const saved = stored?.[BOUNDS_KEY] as { x: number; y: number; width: number; height: number | null } | undefined;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number' && typeof saved.width === 'number') {
      dockBounds.value = clampBounds({ x: saved.x, y: saved.y, width: saved.width, height: null });
    }
    const savedPill = stored?.[PILL_KEY] as { x: number; y: number } | undefined;
    if (savedPill && typeof savedPill.x === 'number' && typeof savedPill.y === 'number') {
      pillPos.value = clampPill(savedPill);
    }
    if (typeof stored?.[CLOSED_KEY] === 'boolean') {
      closed.value = stored[CLOSED_KEY] as boolean;
    }
    if (typeof stored?.[TOOLS_OPEN_KEY] === 'boolean') {
      toolsOpen.value = stored[TOOLS_OPEN_KEY] as boolean;
    }
    const savedFilter = stored?.[SOURCE_FILTER_KEY] as Partial<SourceSearchFilter> | undefined;
    if (savedFilter && typeof savedFilter === 'object') {
      sourceFilter.value = { ...DEFAULT_SOURCE_SEARCH_FILTER, ...savedFilter };
    }
  } catch {
    /* ignore */
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  void getSidePanelState().then((open) => (sidePanelOpen.value = open));
  void loadRoute();
  window.addEventListener('popstate', checkUrlChange);
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('pointerdown', onDocPointerDown, true);
  window.addEventListener('keydown', onDocKeyDown);
  urlCheckTimer = setInterval(checkUrlChange, 400);
});

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  window.removeEventListener('popstate', checkUrlChange);
  window.removeEventListener('resize', onWindowResize);
  window.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('keydown', onDocKeyDown);
  if (urlCheckTimer) clearInterval(urlCheckTimer);
  if (noticeTimer) clearTimeout(noticeTimer);
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
  <template v-if="route.kind !== 'other'">
    <template v-if="!closed">
    <button
      v-if="collapsed"
      class="as-pill"
      :class="{ off: !serverOnline, dragging: pillDragging }"
      :style="pillStyle"
      @pointerdown="startPillDrag"
    >
      <span class="as-wordmark">Atsu<span>Sync</span></span>
    </button>

    <div v-else ref="dockEl" class="as-dock" :style="dockStyle" @wheel="onDockWheel">
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
          class="as-icon-btn"
          :title="toolsOpen ? 'Hide Tools' : 'Open Tools'"
          :aria-label="toolsOpen ? 'Hide Tools' : 'Open Tools'"
          :aria-pressed="toolsOpen"
          @click="toggleTools"
        >
          <Icon name="wrench" />
        </button>
        <button
          class="as-icon-btn"
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

    <div ref="bodyEl" class="as-body">
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
      <!-- LOADING SKELETON -->
      <template v-if="loadingRoute">
        <div class="as-card as-series-card" aria-busy="true" aria-label="Loading series info">
          <div class="as-series-topbar">
            <div class="as-skel as-skel-pill" />
            <div class="as-series-top-actions">
              <div class="as-skel" style="width: 44px; height: 24px; border-radius: 6px" />
              <div class="as-skel" style="width: 24px; height: 24px; border-radius: 6px" />
            </div>
          </div>
          <div class="as-series-hero">
            <div class="as-skel as-skel-cover" />
            <div class="as-series-head">
              <div class="as-skel as-skel-line lg" style="width: 82%" />
              <div class="as-skel as-skel-line" style="width: 55%" />
              <div class="as-row-wrap" style="margin-top: 4px">
                <div class="as-skel as-skel-pill" />
                <div class="as-skel as-skel-pill" style="width: 72px" />
              </div>
            </div>
          </div>
          <div class="as-skel as-skel-line" style="width: 100%; margin-top: 2px" />
          <div class="as-skel as-skel-line" style="width: 78%" />
        </div>

        <div class="as-card" aria-hidden="true">
          <div class="as-row">
            <div class="as-skel as-skel-line lg" style="width: 76px" />
            <div class="as-skel" style="width: 110px; height: 26px; border-radius: 8px" />
          </div>
          <div class="as-skel as-skel-row" />
          <div class="as-skel as-skel-row" style="height: 54px" />
          <div class="as-skel as-skel-row" style="height: 54px" />
        </div>
      </template>

      <!-- UPLOAD PAGE: unresolved hint -->
      <template v-else-if="route.kind === 'upload' && !requestData">
        <div class="as-card">
          <div class="as-muted">Open a tracked series upload page (from a tracked series) to manage and attach its ready downloads.</div>
        </div>
      </template>

      <!-- MANGA PAGE NOT YET TRACKED -->
      <template v-else-if="route.kind === 'manga' && !requestData && serverOnline">
        <div class="as-card">
          <div class="as-muted">This series isn't tracked in AtsuSync yet.</div>
          <button class="as-btn primary" :disabled="busy" @click="trackCurrentManga"><Icon name="plus" /> Track in AtsuSync</button>
        </div>
      </template>

      <!-- REQUEST, TRACKED MANGA, OR RESOLVED UPLOAD SERIES -->
      <template v-else-if="requestData">
        <div class="as-card as-series-card">
          <div class="as-series-topbar">
            <div class="as-row-wrap" style="gap: 5px">
              <span v-if="route.kind === 'request' || !requestData.atsuMangaId" class="as-badge" :class="requestStatusBadgeClass">
                {{ requestStatusLabel }}
              </span>
              <span v-if="requestData.presence?.verdict === 'on_atsu'" class="as-badge green">Already on Atsu</span>
              <span v-else-if="requestData.presence?.verdict === 'claimed'" class="as-badge amber">Claimed</span>
              <span v-else-if="requestData.presence?.verdict === 'possible'" class="as-badge amber">Possible match</span>
            </div>
            <div class="as-series-top-actions">
              <a
                v-if="mangabaka?.url"
                class="as-mini-btn"
                :href="mangabaka.url"
                target="_blank"
                rel="noopener noreferrer"
                :title="`Open on MangaBaka${mangabaka.type ? ` (${mangabaka.type})` : ''}`"
              >
                <Icon name="external" />
                <span>MB</span>
              </a>
              <a
                v-if="showOpenOnAtsu && seriesAtsuUrl"
                class="as-mini-btn"
                :href="seriesAtsuUrl"
                target="_blank"
                rel="noopener noreferrer"
                title="Open on Atsu"
              >
                <Icon name="external" />
                <span>Atsu</span>
              </a>
              <button
                class="as-icon-btn"
                :disabled="mbChecking"
                :title="mbChecking ? 'Checking MangaBaka…' : (mangabaka ? 'Refresh MangaBaka' : 'Check MangaBaka')"
                :aria-label="mbChecking ? 'Checking MangaBaka' : (mangabaka ? 'Refresh MangaBaka' : 'Check MangaBaka')"
                @click="checkMangaBaka"
              >
                <Icon name="refresh" :class="{ 'as-spin': mbChecking }" />
              </button>
              <button
                class="as-icon-btn"
                :title="seriesCollapsed ? 'Expand' : 'Collapse'"
                :aria-label="seriesCollapsed ? 'Expand' : 'Collapse'"
                :aria-expanded="!seriesCollapsed"
                @click="seriesCollapsed = !seriesCollapsed"
              >
                <Icon name="chevronDown" class="as-chevron" :class="{ open: !seriesCollapsed }" />
              </button>
            </div>
          </div>

          <div class="as-collapse" :class="{ collapsed: seriesCollapsed }">
            <div class="as-collapse-inner">
              <div class="as-collapse-body">
                <div class="as-series-hero">
                  <img
                    v-if="coverSrc(seriesCover) && !brokenCovers.has(`series:${seriesCover}`)"
                    :src="coverSrc(seriesCover)!"
                    :alt="requestData.title"
                    class="as-series-cover"
                    referrerpolicy="no-referrer"
                    @error="markBrokenCover(`series:${seriesCover}`)"
                  />
                  <div v-else class="as-series-cover-fallback" aria-hidden="true">
                    <Icon name="book" />
                  </div>

                  <div class="as-series-head">
                    <div v-if="!editingTitle" class="as-series-title-row">
                      <div class="as-series-title" :title="requestData.title">{{ requestData.title }}</div>
                      <button
                        v-if="route.kind === 'request'"
                        class="as-icon-btn"
                        title="Overwrite post title"
                        aria-label="Overwrite post title"
                        @click="startEditTitle"
                      >
                        <Icon name="edit" />
                      </button>
                    </div>
                    <div v-else class="as-card" style="padding: 0; gap: 6px; background: transparent">
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

                    <div v-if="seriesMetaLine" class="as-series-meta">{{ seriesMetaLine }}</div>

                    <div class="as-series-badges">
                      <span v-if="mangabaka?.status" class="as-badge" :class="mbStatusBadgeClass">
                        {{ formatLabel(mangabaka.status) }}
                      </span>
                      <span v-if="seriesAtsuChapters !== null" class="as-badge">
                        Atsu: {{ seriesAtsuChapters }} ch
                      </span>
                      <span v-if="mangabaka?.totalChapters != null" class="as-badge indigo" :title="mangabaka.title">
                        MB: {{ mangabaka.totalChapters }} ch
                      </span>
                    </div>
                  </div>
                </div>

                <div v-if="seriesGenres.length || requestExtraTags.length" class="as-source-chips">
                  <span v-for="t in requestExtraTags" :key="`tag-${t.id}`" class="as-series-chip">
                    <template v-if="t.emoji">{{ t.emoji }} </template>{{ t.name }}
                  </span>
                  <span v-for="g in seriesGenres" :key="`genre-${g}`" class="as-series-chip">{{ g }}</span>
                </div>

                <div v-if="seriesDescription" class="as-series-desc-wrap">
                  <div class="as-series-desc" :class="{ clamped: !descExpanded }">{{ seriesDescription }}</div>
                  <button
                    v-if="seriesDescription.length > 140"
                    type="button"
                    class="as-btn ghost sm as-desc-toggle"
                    @click="descExpanded = !descExpanded"
                  >
                    {{ descExpanded ? 'Show less' : 'Show more' }}
                  </button>
                </div>

                <div v-if="(route.kind === 'request' && (requestData.authorName || requestData.commentCount > 0)) || canUntrack" class="as-series-footer">
                  <span v-if="route.kind === 'request' && (requestData.authorName || requestData.commentCount > 0)">
                    <template v-if="requestData.authorName">Requested by {{ requestData.authorName }}</template>
                    <template v-if="requestData.authorName && requestData.commentCount > 0"> · </template>
                    <template v-if="requestData.commentCount > 0">{{ requestData.commentCount }} {{ requestData.commentCount === 1 ? 'comment' : 'comments' }}</template>
                  </span>
                  <button
                    v-if="canUntrack"
                    class="as-btn danger sm"
                    style="margin-left: auto"
                    :disabled="busy"
                    title="Untrack series"
                    @click="untrackCurrentSeries"
                  >
                    <Icon name="trash" /> Untrack
                  </button>
                </div>

                <AlertBanner
                  v-if="mbMismatch"
                  kind="warn"
                  :message="`Linked MangaBaka entry is &quot;${mangabaka?.type}&quot;, which does not match this request's medium.`"
                />
              </div>
            </div>
          </div>
        </div>

        <LinkSection
          v-for="l in links"
          :key="l.id"
          :link="l"
          :is-upload-page="route.kind === 'upload'"
          @unlinked="onLinkUnlinked"
          @updated="refreshLinks"
        />

        <div class="as-card">
          <div class="as-row" style="align-items: flex-start">
            <span class="as-title" style="flex: 1; min-width: 0">Sources</span>
            <button
              class="as-icon-btn"
              :title="sourcesCollapsed ? 'Expand' : 'Collapse'"
              :aria-label="sourcesCollapsed ? 'Expand' : 'Collapse'"
              :aria-expanded="!sourcesCollapsed"
              @click="sourcesCollapsed = !sourcesCollapsed"
            >
              <Icon name="chevronDown" class="as-chevron" :class="{ open: !sourcesCollapsed }" />
            </button>
          </div>

          <template v-if="!sourcesCollapsed">
          <div class="as-row-wrap" style="justify-content: flex-end">
            <div ref="sourceFilterWrapEl" class="as-filter-wrap">
              <button
                type="button"
                class="as-btn sm"
                :class="{ 'as-filter-active': isSourceFiltered }"
                :aria-expanded="sourceFilterOpen"
                title="Filter which sources to search"
                @click="sourceFilterOpen = !sourceFilterOpen"
              >
                <Icon name="filter" />
                <span v-if="isSourceFiltered">{{ activeFilterCount }}/{{ SOURCE_FILTER_OPTIONS.length }}</span>
              </button>
              <div v-if="sourceFilterOpen" class="as-filter-menu right" role="menu" aria-label="Source filter">
                <label v-for="opt in SOURCE_FILTER_OPTIONS" :key="opt.key" class="as-filter-item">
                  <input v-model="sourceFilter[opt.key]" type="checkbox" />
                  <span>{{ opt.label }}</span>
                </label>
              </div>
            </div>
            <button
              v-if="searching"
              class="as-btn danger sm"
              @click="stopFindSources"
            >
              <Icon name="x" /> Stop<template v-if="searchTotal"> ({{ searchDone }}/{{ searchTotal }})</template>
            </button>
            <button
              v-else
              class="as-btn primary sm"
              :disabled="busy || !hasAnyKindSelected"
              @click="findSources"
            >
              <Icon name="search" /> Find sources
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

          <div v-if="matches.length > 0" class="as-row" style="gap: 6px; flex-wrap: wrap">
            <input
              v-model="sourceMatchFilter"
              class="as-input"
              type="search"
              placeholder="Filter matches…"
              style="flex: 1; min-width: 120px; height: 30px; font-size: 12px"
            />
            <div ref="sourceSortWrapEl" class="as-filter-wrap">
              <button
                type="button"
                class="as-btn sm"
                :aria-expanded="sourceSortOpen"
                aria-label="Sort sources"
                style="height: 30px"
                @click="sourceSortOpen = !sourceSortOpen"
              >
                <span>{{ sourceSortLabel }}</span>
                <Icon name="chevronDown" class="as-chevron" :class="{ open: sourceSortOpen }" />
              </button>
              <div v-if="sourceSortOpen" class="as-filter-menu right" role="menu" aria-label="Sort sources">
                <button
                  v-for="opt in SOURCE_SORT_OPTIONS"
                  :key="opt.value"
                  type="button"
                  role="menuitemradio"
                  :aria-checked="sourceMatchSort === opt.value"
                  class="as-filter-item as-filter-opt"
                  :class="{ active: sourceMatchSort === opt.value }"
                  @click="sourceMatchSort = opt.value; sourceSortOpen = false"
                >
                  <span>{{ opt.label }}</span>
                </button>
              </div>
            </div>
          </div>
          <div v-if="filteredMatches.length === 0 && sourceMatchFilter.trim()" class="as-muted">
            No sources match "{{ sourceMatchFilter }}".
          </div>

          <template v-if="searching && matches.length === 0">
            <div v-for="n in 3" :key="`skel-src-${n}`" class="as-chap" aria-hidden="true">
              <div class="as-skel as-skel-thumb" />
              <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px">
                <div class="as-skel as-skel-line" style="width: 74%" />
                <div class="as-skel as-skel-line sm" style="width: 48%" />
              </div>
              <div class="as-skel" style="width: 56px; height: 28px; border-radius: 8px" />
            </div>
          </template>

          <div v-for="m in filteredMatches" :key="m.seriesUrl" class="as-chap" style="align-items: center">
            <img
              v-if="coverSrc(m.cover) && !brokenCovers.has(m.seriesUrl)"
              :src="coverSrc(m.cover)!"
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
              class="as-icon-btn"
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
          </template>
        </div>
      </template>
      </template>
    </div>

    <div v-if="error || notice" class="as-toast-stack">
      <AlertBanner
        v-if="error"
        kind="error"
        variant="toast"
        dismissible
        :message="error"
        @dismiss="error = null"
      />
      <AlertBanner
        v-if="notice"
        kind="ok"
        variant="toast"
        dismissible
        :message="notice"
        @dismiss="notice = null"
      />
    </div>
  </div>
  </template>
  <ToolsWindow :open="toolsOpen" :route-kind="route.kind" @close="setToolsOpen(false)" />
  </template>
</template>
