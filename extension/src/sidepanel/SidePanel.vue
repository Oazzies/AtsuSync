<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_SOURCE_SEARCH_FILTER,
  SOURCE_FILTER_OPTIONS,
  matchesSourceFilter,
  type Link,
  type NotificationSettings,
  type SettingsView,
  type SourceInfo,
  type SourceSearchFilter,
  type LncrawlStatus,
  type LnreaderStatus,
  type SuwayomiExtensionInfo,
  type SuwayomiStatus,
  type UpdateStatus,
} from '@atsusync/shared';
import { api, START_SERVER_URL, syncCookiesNow, useCoverResolver, useServerEvents, waitForServerOnline } from '../api';
import AlertBanner from '../ui/AlertBanner.vue';
import Icon from '../ui/Icon.vue';

const NOTIFICATION_SETTINGS_KEY = 'atsuSync.notifications';
const NOTIFICATION_OPTIONS: { key: keyof NotificationSettings; label: string; description: string }[] = [
  { key: 'new_chapters', label: 'New chapters', description: 'When a tracked series gets new chapters' },
  { key: 'chapters_unlocked', label: 'Chapters unlocked', description: 'When locked chapters become free to download' },
  { key: 'downloads_complete', label: 'Downloads complete', description: 'When chapter ZIPs finish downloading' },
  { key: 'discovery_done', label: 'Source search finished', description: 'When background source discovery finishes' },
];

const tab = ref<'tracked' | 'sources' | 'settings'>('tracked');
const notifications = ref<NotificationSettings>({ ...DEFAULT_NOTIFICATION_SETTINGS });
const online = ref<boolean | null>(null);
const starting = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
let startAbort: AbortController | null = null;
const query = ref('');

const links = ref<Link[]>([]);
const sources = ref<SourceInfo[]>([]);
const settings = ref<SettingsView | null>(null);
const brokenCovers = ref(new Set<number>());
const { coverSrc, preload: preloadCovers } = useCoverResolver();
watch(links, (list) => preloadCovers(list.map((l) => l.cover)), { immediate: true });

// Keiyoushi / Suwayomi state
const suwayomiStatus = ref<SuwayomiStatus | null>(null);
const settingUpSuwayomi = ref(false);
// LNCrawl state
const lncrawlStatus = ref<LncrawlStatus | null>(null);
const settingUpLncrawl = ref(false);
// LNReader state
const lnreaderStatus = ref<LnreaderStatus | null>(null);
const syncingLnreader = ref(false);
const showExtensions = ref(false);
const loadingExtensions = ref(false);
const extensions = ref<SuwayomiExtensionInfo[]>([]);
const extSearch = ref('');
const sourceSearch = ref('');
const SIDEBAR_SOURCE_FILTER_KEY = 'atsusync_sidebar_source_filter';
const sourceFilter = ref<SourceSearchFilter>({ ...DEFAULT_SOURCE_SEARCH_FILTER });
const sourceFilterOpen = ref(false);
const sourceFilterWrapEl = ref<HTMLElement | null>(null);
const activeFilterCount = computed(() => SOURCE_FILTER_OPTIONS.filter((o) => sourceFilter.value[o.key]).length);
const isSourceFiltered = computed(() => activeFilterCount.value < SOURCE_FILTER_OPTIONS.length);
const busyPkg = ref<Record<string, boolean>>({});

const filteredExtensions = computed(() => {
  const q = extSearch.value.trim().toLowerCase();
  return extensions.value.filter((e) =>
    !q ? true : e.name.toLowerCase().includes(q) || e.pkgName.toLowerCase().includes(q),
  );
});

const filteredSources = computed(() => {
  const q = sourceSearch.value.trim().toLowerCase();
  return sources.value.filter((s) => {
    if (!matchesSourceFilter(s, sourceFilter.value)) return false;
    return !q ? true : s.name.toLowerCase().includes(q) || s.kind.toLowerCase().includes(q);
  });
});

// Active tab context for smart Tracked filtering
const activeTabId = ref<number | null>(null);
const activeTabUrl = ref<string | null>(null);
const activeRequestId = ref<string | null>(null);
const activeMangaId = ref<string | null>(null);
const showAllOnPage = ref(false);
const dockOpen = ref(false);
const toolsOpen = ref(false);
const showFullyOnAtsu = ref(false);
const resolvedSourceCache = new Map<string, { requestId: string | null; mangaId: string | null }>();

async function updateActiveContext(urlStr: string | null | undefined) {
  activeTabUrl.value = urlStr ?? null;
  activeRequestId.value = null;
  activeMangaId.value = null;
  showAllOnPage.value = false;
  if (!urlStr || !urlStr.startsWith('https://atsu.moe/')) return;

  try {
    const u = new URL(urlStr);
    const p = u.pathname;
    const reqMatch = p.match(/^\/social\/forum\/[^/]+\/content-requests\/([^/]+)\/?$/);
    if (reqMatch?.[1]) {
      activeRequestId.value = reqMatch[1];
      return;
    }
    const mangaMatch = p.match(/^\/manga\/([^/]+)\/?$/);
    if (mangaMatch?.[1]) {
      activeMangaId.value = mangaMatch[1];
      return;
    }
    if (p === '/upload' || p.startsWith('/upload/')) {
      const manga = u.searchParams.get('manga');
      const source = u.searchParams.get('source');
      if (manga) {
        activeMangaId.value = manga;
        return;
      }
      if (source) {
        const cached = resolvedSourceCache.get(source);
        if (cached) {
          activeRequestId.value = cached.requestId;
          activeMangaId.value = cached.mangaId;
          return;
        }
        try {
          const res = await api.resolveUpload({ sourceId: source });
          const val = {
            requestId: res.request?.id ?? null,
            mangaId: res.resolved.mangaId ?? res.request?.atsuMangaId ?? null,
          };
          resolvedSourceCache.set(source, val);
          // Guard against tab changing while resolving
          if (activeTabUrl.value === urlStr) {
            activeRequestId.value = val.requestId;
            activeMangaId.value = val.mangaId;
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

const hasPageFilter = computed(() => !!(activeRequestId.value || activeMangaId.value));

function matchesActivePage(l: Link): boolean {
  if (activeRequestId.value && l.requestId === activeRequestId.value) return true;
  if (activeMangaId.value) {
    if (l.atsuMangaId === activeMangaId.value) return true;
    if (l.requestId === `atsu:${activeMangaId.value}`) return true;
  }
  return false;
}

function needsUpload(l: Link): boolean {
  return l.missingCount > 0 || l.pendingCount > 0;
}

const needingCount = computed(() => links.value.filter(needsUpload).length);

const baseLinks = computed(() => {
  if (hasPageFilter.value && !showAllOnPage.value) {
    return links.value.filter(matchesActivePage);
  }
  if (!showFullyOnAtsu.value) {
    return links.value.filter(needsUpload);
  }
  return links.value;
});

const filteredLinks = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return baseLinks.value;
  return baseLinks.value.filter(
    (l) =>
      l.seriesTitle.toLowerCase().includes(q) ||
      l.requestTitle.toLowerCase().includes(q) ||
      l.sourceName.toLowerCase().includes(q),
  );
});

function markBrokenCover(linkId: number) {
  const next = new Set(brokenCovers.value);
  next.add(linkId);
  brokenCovers.value = next;
}

async function load(refreshAtsuState = false) {
  error.value = null;
  try {
    if (refreshAtsuState) {
      await api.refreshAtsu().catch(() => null);
    }
    const [s, l, src, sw, ln, lnr] = await Promise.all([
      api.settings(),
      api.links(),
      api.sources(),
      api.suwayomiStatus().catch(() => null),
      api.lncrawlStatus().catch(() => null),
      api.lnreaderStatus().catch(() => null),
    ]);
    online.value = true;
    settings.value = s;
    links.value = l;
    sources.value = src;
    suwayomiStatus.value = sw;
    lncrawlStatus.value = ln;
    lnreaderStatus.value = lnr;
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 0) online.value = false;
    error.value = err.message;
  }
}

async function syncDockState(tab?: chrome.tabs.Tab | null) {
  if (!tab?.id || !tab.url?.startsWith('https://atsu.moe/')) {
    dockOpen.value = false;
    toolsOpen.value = false;
    return;
  }
  const tabId = tab.id;
  const res = (await chrome.tabs.sendMessage(tabId, { type: 'getDockState' }).catch(() => null)) as
    | { open?: boolean; toolsOpen?: boolean }
    | null;
  if (activeTabId.value === tabId) {
    dockOpen.value = Boolean(res?.open);
    toolsOpen.value = Boolean(res?.toolsOpen);
  }
}

async function syncActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  activeTabId.value = active?.id ?? null;
  await Promise.all([updateActiveContext(active?.url), syncDockState(active)]);
}

function onTabActivated() {
  void syncActiveTab();
}

function onTabUpdated(tabId: number, changeInfo: { url?: string; status?: string }, tabInfo: chrome.tabs.Tab) {
  if (tabInfo.active && (changeInfo.url || changeInfo.status === 'complete')) {
    activeTabId.value = tabId;
    void updateActiveContext(changeInfo.url ?? tabInfo.url);
    void syncDockState(tabInfo);
  }
}

function onRuntimeMessage(msg: unknown, sender: chrome.runtime.MessageSender) {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as { type?: string; open?: boolean };
  if (sender.tab?.id !== undefined && sender.tab.id === activeTabId.value && typeof m.open === 'boolean') {
    if (m.type === 'dockState') dockOpen.value = m.open;
    else if (m.type === 'toolsState') toolsOpen.value = m.open;
  }
}

let sidePanelPort: chrome.runtime.Port | null = null;

function connectSidePanelPort() {
  try {
    sidePanelPort = chrome.runtime.connect({ name: 'sidepanel' });
    sidePanelPort.onMessage.addListener((msg: { type?: string }) => {
      if (msg?.type === 'close') window.close();
    });
    chrome.windows.getCurrent((win) => {
      if (win?.id !== undefined) {
        sidePanelPort?.postMessage({ type: 'init', windowId: win.id });
      }
    });
  } catch {
    /* ignore */
  }
}

async function loadNotificationSettings() {
  try {
    const stored = await chrome.storage?.local?.get(NOTIFICATION_SETTINGS_KEY);
    const raw = stored?.[NOTIFICATION_SETTINGS_KEY];
    if (raw && typeof raw === 'object') {
      notifications.value = { ...DEFAULT_NOTIFICATION_SETTINGS, ...(raw as Partial<NotificationSettings>) };
    }
  } catch {
    /* ignore */
  }
}

function toggleNotification(key: keyof NotificationSettings) {
  const next: NotificationSettings = {
    ...notifications.value,
    [key]: !notifications.value[key],
  };
  notifications.value = next;
  void chrome.storage?.local?.set({ [NOTIFICATION_SETTINGS_KEY]: next });
}

function onDocPointerDown(e: PointerEvent) {
  if (!sourceFilterOpen.value) return;
  const wrap = sourceFilterWrapEl.value;
  if (wrap && !e.composedPath().includes(wrap)) {
    sourceFilterOpen.value = false;
  }
}

function onDocKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && sourceFilterOpen.value) {
    sourceFilterOpen.value = false;
  }
}

watch(
  sourceFilter,
  (val) => {
    try {
      void chrome.storage?.local?.set({ [SIDEBAR_SOURCE_FILTER_KEY]: { ...val } });
    } catch {
      /* ignore */
    }
  },
  { deep: true },
);

onMounted(async () => {
  connectSidePanelPort();
  void loadNotificationSettings();
  try {
    const stored = await chrome.storage?.local?.get(SIDEBAR_SOURCE_FILTER_KEY);
    const savedFilter = stored?.[SIDEBAR_SOURCE_FILTER_KEY] as Partial<SourceSearchFilter> | undefined;
    if (savedFilter && typeof savedFilter === 'object') {
      sourceFilter.value = { ...DEFAULT_SOURCE_SEARCH_FILTER, ...savedFilter };
    }
  } catch {
    /* ignore */
  }
  void load(false);
  void checkUpdates(false);
  void syncActiveTab();
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  window.addEventListener('pointerdown', onDocPointerDown, true);
  window.addEventListener('keydown', onDocKeyDown);
});

onUnmounted(() => {
  sidePanelPort?.disconnect();
  sidePanelPort = null;
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  chrome.tabs.onActivated.removeListener(onTabActivated);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);
  window.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('keydown', onDocKeyDown);
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
    await load(false);
    await syncActiveTab();
  }
}

watch(links, () => {
  if (activeTabUrl.value && !hasPageFilter.value) {
    void updateActiveContext(activeTabUrl.value);
  }
});

useServerEvents((ev) => {
  if (ev.type === 'job' && (ev.job.state === 'done' || ev.job.state === 'failed')) {
    void api.links().then((l) => (links.value = l));
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

async function toggleTabWindow(type: 'toggleDock' | 'toggleTools', label: string, stateRef: typeof dockOpen) {
  error.value = null;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== undefined && active.url?.startsWith('https://atsu.moe/')) {
    try {
      const res = (await chrome.tabs.sendMessage(active.id, { type })) as { open?: boolean } | undefined;
      if (typeof res?.open === 'boolean') {
        stateRef.value = res.open;
      }
    } catch {
      stateRef.value = false;
      error.value = `Reload the atsu.moe tab to connect the ${label}.`;
    }
  } else {
    stateRef.value = false;
    error.value = `Open an atsu.moe tab first to summon the ${label}.`;
  }
}

function toggleDock() {
  return toggleTabWindow('toggleDock', 'floating window', dockOpen);
}

function toggleTools() {
  return toggleTabWindow('toggleTools', 'tools window', toolsOpen);
}

async function checkLink(id: number) {
  busy.value = true;
  try {
    await api.checkLink(id);
    await load(false);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function toggleSource(s: SourceInfo) {
  sources.value = await api.setSourceEnabled(s.id, !s.enabled);
}

async function setupSuwayomi() {
  settingUpSuwayomi.value = true;
  error.value = null;
  try {
    const res = await api.setupSuwayomi();
    suwayomiStatus.value = res.status;
    sources.value = res.sources;
    await loadExtensions();
    showExtensions.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    suwayomiStatus.value = await api.suwayomiStatus().catch(() => null);
  } finally {
    settingUpSuwayomi.value = false;
  }
}

async function stopSuwayomi() {
  error.value = null;
  try {
    suwayomiStatus.value = await api.stopSuwayomi();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function syncSuwayomi() {
  busy.value = true;
  error.value = null;
  try {
    const res = await api.syncSuwayomi();
    sources.value = res.sources;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function setupLncrawl() {
  settingUpLncrawl.value = true;
  error.value = null;
  try {
    const res = await api.setupLncrawl();
    lncrawlStatus.value = res.status;
    sources.value = res.sources;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    lncrawlStatus.value = await api.lncrawlStatus().catch(() => null);
  } finally {
    settingUpLncrawl.value = false;
  }
}

async function stopLncrawl() {
  error.value = null;
  try {
    lncrawlStatus.value = await api.stopLncrawl();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function syncLncrawl() {
  busy.value = true;
  error.value = null;
  try {
    const res = await api.syncLncrawl();
    sources.value = res.sources;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function syncLnreader() {
  syncingLnreader.value = true;
  error.value = null;
  try {
    const res = await api.syncLnreader();
    lnreaderStatus.value = res.status;
    sources.value = res.sources;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    lnreaderStatus.value = await api.lnreaderStatus().catch(() => null);
  } finally {
    syncingLnreader.value = false;
  }
}

async function disableLnreader() {
  error.value = null;
  try {
    const res = await api.disableLnreader();
    lnreaderStatus.value = res.status;
    sources.value = res.sources;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function loadExtensions() {
  loadingExtensions.value = true;
  try {
    const res = await api.suwayomiExtensions();
    extensions.value = res.extensions;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loadingExtensions.value = false;
  }
}

async function toggleExtensionsBrowser() {
  showExtensions.value = !showExtensions.value;
  if (showExtensions.value && !extensions.value.length) {
    await loadExtensions();
  }
}

async function setExtInstalled(ext: SuwayomiExtensionInfo, install: boolean) {
  busyPkg.value = { ...busyPkg.value, [ext.pkgName]: true };
  error.value = null;
  try {
    const res = install ? await api.installSuwayomiExtension(ext.pkgName) : await api.uninstallSuwayomiExtension(ext.pkgName);
    sources.value = res.sources;
    ext.isInstalled = install;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyPkg.value = { ...busyPkg.value, [ext.pkgName]: false };
  }
}

const stoppingServer = ref(false);
const updateStatus = ref<UpdateStatus | null>(null);
const checkingUpdate = ref(false);
const applyingUpdate = ref(false);
const updateMessage = ref<string | null>(null);

async function checkUpdates(refresh = true) {
  if (checkingUpdate.value) return;
  checkingUpdate.value = true;
  if (refresh) updateMessage.value = null;
  try {
    updateStatus.value = await api.checkUpdate(refresh);
  } catch (e) {
    if (refresh) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    checkingUpdate.value = false;
  }
}

async function applyUpdateNow() {
  if (applyingUpdate.value) return;
  applyingUpdate.value = true;
  error.value = null;
  updateMessage.value = null;
  try {
    const res = await api.applyUpdate();
    updateMessage.value = res.message;
    if (res.updated) {
      updateStatus.value = await api.checkUpdate(true).catch(() => updateStatus.value);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    applyingUpdate.value = false;
  }
}

async function stopServer() {
  if (stoppingServer.value) return;
  stoppingServer.value = true;
  error.value = null;
  try {
    await api.stopServer();
    online.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    stoppingServer.value = false;
  }
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
</script>

<template>
  <div class="sp-shell">
    <div v-if="online === null" class="sp-shell" aria-busy="true" aria-label="Loading AtsuSync">
      <div class="sp-tabs-wrap">
        <div class="sp-tabs" aria-hidden="true">
          <div class="sp-skel" style="flex: 1; height: 32px; border-radius: 7px" />
          <div class="sp-skel" style="flex: 1; height: 32px; border-radius: 7px" />
          <div class="sp-skel" style="flex: 1; height: 32px; border-radius: 7px" />
        </div>
        <div class="sp-tabs-actions" aria-hidden="true">
          <div class="sp-skel" style="width: 30px; height: 30px; border-radius: 6px" />
          <div class="sp-skel" style="width: 30px; height: 30px; border-radius: 6px" />
        </div>
      </div>
      <main class="sp-body" aria-hidden="true">
        <div v-for="n in 3" :key="`sp-skel-${n}`" class="sp-card">
          <div class="sp-series-head">
            <div class="sp-skel sp-skel-cover" />
            <div class="sp-series-info" style="gap: 7px">
              <div class="sp-skel sp-skel-line lg" style="width: 82%" />
              <div class="sp-skel sp-skel-line sm" style="width: 56%" />
              <div class="sp-badges">
                <div class="sp-skel sp-skel-pill" />
                <div class="sp-skel sp-skel-pill" style="width: 48px" />
              </div>
            </div>
          </div>
          <div class="sp-series-actions">
            <div class="sp-skel" style="flex: 1; height: 30px; border-radius: 8px" />
            <div class="sp-skel" style="width: 74px; height: 30px; border-radius: 8px" />
          </div>
        </div>
      </main>
    </div>

    <div v-else-if="online === false" class="sp-offline-screen">
      <a
        :href="START_SERVER_URL"
        class="sp-start-btn"
        :class="{ starting }"
        :aria-disabled="starting"
        @click="starting ? $event.preventDefault() : handleStartServer()"
      >
        <Icon :name="starting ? 'refresh' : 'power'" :class="{ 'sp-spin': starting }" />
        <span>{{ starting ? 'Starting Server…' : 'Start Server' }}</span>
      </a>
    </div>

    <template v-else-if="online === true">
    <div class="sp-tabs-wrap">
      <div class="sp-tabs" role="tablist">
        <button class="sp-tab" role="tab" :aria-selected="tab === 'tracked'" :class="{ active: tab === 'tracked' }" @click="tab = 'tracked'">
          <Icon name="bell" />
          <span>Tracked</span>
          <span class="sp-tab-count">{{ needingCount }}</span>
        </button>
        <button class="sp-tab" role="tab" :aria-selected="tab === 'sources'" :class="{ active: tab === 'sources' }" @click="tab = 'sources'">
          <Icon name="globe" />
          <span>Sources</span>
        </button>
        <button class="sp-tab" role="tab" :aria-selected="tab === 'settings'" :class="{ active: tab === 'settings' }" @click="tab = 'settings'">
          <Icon name="settings" />
          <span>Settings</span>
          <span v-if="updateStatus?.updateAvailable" class="sp-tab-count" title="Update available">!</span>
        </button>
      </div>
      <div class="sp-tabs-actions">
        <button
          class="sp-icon-btn"
          :title="dockOpen ? 'Close upload window on atsu.moe' : 'Open upload window on atsu.moe'"
          :aria-label="dockOpen ? 'Close upload window on atsu.moe' : 'Open upload window on atsu.moe'"
          @click="toggleDock"
        >
          <Icon name="upload" />
        </button>
        <button
          class="sp-icon-btn"
          :title="toolsOpen ? 'Close tools window on atsu.moe' : 'Open tools window on atsu.moe'"
          :aria-label="toolsOpen ? 'Close tools window on atsu.moe' : 'Open tools window on atsu.moe'"
          @click="toggleTools"
        >
          <Icon name="wrench" />
        </button>
      </div>
    </div>

    <main class="sp-body">
      <template v-if="tab === 'tracked'">
        <div v-if="hasPageFilter" class="sp-row">
          <span class="sp-muted">{{ showAllOnPage ? 'Showing all' : 'On current page' }}</span>
          <button class="sp-btn ghost sm" @click="showAllOnPage = !showAllOnPage">
            {{ showAllOnPage ? 'This series only' : 'Show all' }}
          </button>
        </div>
        <div v-else-if="links.length > 0" class="sp-row">
          <span class="sp-muted">{{ showFullyOnAtsu ? `All tracked (${links.length})` : `Needs upload (${needingCount})` }}</span>
          <button v-if="links.length > needingCount" class="sp-btn ghost sm" @click="showFullyOnAtsu = !showFullyOnAtsu">
            {{ showFullyOnAtsu ? 'Needs upload only' : `Show all (${links.length})` }}
          </button>
        </div>

        <div v-if="baseLinks.length > 2" class="sp-search-wrap">
          <span class="sp-search-icon"><Icon name="search" /></span>
          <input v-model="query" class="sp-input with-icon" type="search" placeholder="Filter tracked series…" />
        </div>

        <div v-if="!links.length" class="sp-card">
          <div class="sp-muted">No linked series yet. Open any content request, series, or upload page on atsu.moe to link a source.</div>
        </div>
        <div v-else-if="!filteredLinks.length" class="sp-card">
          <div class="sp-muted">
            <template v-if="hasPageFilter && !showAllOnPage">This series is not tracked yet. Summon the floating window to link a source.</template>
            <template v-else-if="!showFullyOnAtsu && !query.trim()">All tracked series are up to date on Atsu.</template>
            <template v-else>No tracked series match "{{ query }}".</template>
          </div>
        </div>

        <article v-for="l in filteredLinks" :key="l.id" class="sp-card">
          <div class="sp-series-head">
            <div class="sp-cover-wrap">
              <img
                v-if="coverSrc(l.cover) && !brokenCovers.has(l.id)"
                :src="coverSrc(l.cover)!"
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
              <div v-if="l.missingCount || l.pendingCount" class="sp-badges">
                <span v-if="l.missingCount" class="sp-badge amber">{{ l.missingCount }} missing</span>
                <span v-if="l.pendingCount" class="sp-badge indigo">{{ l.pendingCount }} new</span>
              </div>
            </div>
          </div>

          <AlertBanner v-if="l.lastError" kind="error" prefix="sp" :message="l.lastError" />

          <div class="sp-series-actions">
            <button class="sp-btn primary" @click="openUrl(atsuUrlForLink(l))">
              <Icon name="external" /> Open on Atsu
            </button>
            <button class="sp-btn compact" :disabled="busy" @click="checkLink(l.id)">
              <Icon name="refresh" /> Check
            </button>
          </div>
        </article>
      </template>

      <template v-else-if="tab === 'sources'">
        <div class="sp-card">
          <div class="sp-row" style="margin-bottom: 8px">
            <div class="sp-section-title" style="margin: 0">
              Sources ({{ filteredSources.length }}<span v-if="sourceSearch.trim() || isSourceFiltered"> / {{ sources.length }}</span>)
            </div>
            <div ref="sourceFilterWrapEl" class="sp-filter-wrap">
              <button
                type="button"
                class="sp-btn sm"
                :class="{ 'sp-filter-active': isSourceFiltered }"
                :aria-expanded="sourceFilterOpen"
                title="Filter sources by category"
                @click="sourceFilterOpen = !sourceFilterOpen"
              >
                <Icon name="filter" />
                <span v-if="isSourceFiltered">{{ activeFilterCount }}/{{ SOURCE_FILTER_OPTIONS.length }}</span>
              </button>
              <div v-if="sourceFilterOpen" class="sp-filter-menu" role="menu" aria-label="Source filter">
                <label v-for="opt in SOURCE_FILTER_OPTIONS" :key="opt.key" class="sp-filter-item">
                  <input v-model="sourceFilter[opt.key]" type="checkbox" />
                  <span>{{ opt.label }}</span>
                </label>
              </div>
            </div>
          </div>
          <input v-model="sourceSearch" class="sp-input" type="search" placeholder="Filter sources…" style="margin-bottom: 8px" />
          <div v-if="!filteredSources.length" class="sp-muted" style="padding: 6px 2px">
            No sources match the current filter.
          </div>
          <div v-else>
            <label v-for="s in filteredSources" :key="s.id" class="sp-source-row">
              <span class="sp-source-name">
                <span>{{ s.name }}</span>
                <span class="sp-muted">({{ s.kind }})</span>
              </span>
              <input type="checkbox" :checked="s.enabled" @change="toggleSource(s)" />
            </label>
          </div>
        </div>
      </template>

      <template v-else-if="tab === 'settings'">
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
        </div>

        <div class="sp-card">
          <div class="sp-row">
            <div style="min-width: 0">
              <div class="sp-title">Keiyoushi &amp; Yūzōnō / Suwayomi</div>
              <div class="sp-muted">
                {{ suwayomiStatus?.running ? (suwayomiStatus.managed ? 'Running (managed)' : 'Connected') : 'Not running' }}
              </div>
            </div>
            <button v-if="!suwayomiStatus?.running" class="sp-btn primary sm" :disabled="settingUpSuwayomi" @click="setupSuwayomi">
              <Icon name="download" :class="{ 'sp-spin': settingUpSuwayomi }" />
              {{ settingUpSuwayomi ? 'Setting up…' : 'Auto-setup' }}
            </button>
            <div v-else class="sp-row" style="gap: 6px">
              <button class="sp-btn sm" :disabled="loadingExtensions" @click="toggleExtensionsBrowser">
                {{ showExtensions ? 'Hide' : 'Extensions' }}
              </button>
              <button class="sp-btn sm" :disabled="busy" title="Sync sources" @click="syncSuwayomi">
                <Icon name="refresh" :class="{ 'sp-spin': busy }" />
              </button>
              <button v-if="suwayomiStatus.managed" class="sp-btn ghost sm" @click="stopSuwayomi">Stop</button>
            </div>
          </div>
          <div v-if="!suwayomiStatus?.running" class="sp-muted" style="font-size: 11px; line-height: 1.4">
            <template v-if="suwayomiStatus?.jarPresent">
              Installed locally (~1.1 GB on disk). Click Auto-setup to start.
            </template>
            <template v-else>
              Downloads Suwayomi-Server, Chromium runtime &amp; English extensions (~1.1 GB disk space; Java is installed automatically if missing).
            </template>
          </div>

          <div v-if="showExtensions" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px">
            <input v-model="extSearch" class="sp-input" type="search" placeholder="Search English Keiyoushi / Yūzōnō extensions…" />
            <div v-if="loadingExtensions" style="display: flex; flex-direction: column; gap: 6px" aria-busy="true" aria-label="Loading extension catalog">
              <div v-for="n in 4" :key="`ext-skel-${n}`" class="sp-row" style="gap: 8px" aria-hidden="true">
                <div class="sp-skel sp-skel-line" :style="{ width: `${45 + (n % 3) * 15}%` }" />
                <div class="sp-skel" style="width: 54px; height: 26px; border-radius: 6px" />
              </div>
            </div>
            <template v-else>
              <div class="sp-muted" style="font-size: 11px">{{ filteredExtensions.length }} English extensions</div>
              <div style="display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto">
                <div v-for="ext in filteredExtensions" :key="ext.pkgName" class="sp-row" style="gap: 8px">
                  <div style="min-width: 0; flex: 1">
                    <div style="font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                      {{ ext.name }} <span class="sp-muted">({{ ext.lang.toUpperCase() }})</span>
                    </div>
                  </div>
                  <button
                    class="sp-btn sm"
                    :class="{ primary: !ext.isInstalled }"
                    :disabled="busyPkg[ext.pkgName]"
                    @click="setExtInstalled(ext, !ext.isInstalled)"
                  >
                    {{ busyPkg[ext.pkgName] ? '…' : ext.isInstalled ? 'Remove' : 'Install' }}
                  </button>
                </div>
              </div>
            </template>
          </div>
        </div>

        <div class="sp-card">
          <div class="sp-row">
            <div style="min-width: 0">
              <div class="sp-title">LNCrawl (Novels)</div>
              <div class="sp-muted">
                {{ lncrawlStatus?.running ? (lncrawlStatus.managed ? 'Running (managed)' : 'Connected') : 'Not running' }}
              </div>
            </div>
            <button v-if="!lncrawlStatus?.running" class="sp-btn primary sm" :disabled="settingUpLncrawl" @click="setupLncrawl">
              <Icon name="download" :class="{ 'sp-spin': settingUpLncrawl }" />
              {{ settingUpLncrawl ? 'Setting up…' : 'Auto-setup' }}
            </button>
            <div v-else class="sp-row" style="gap: 6px">
              <button class="sp-btn sm" :disabled="busy" title="Sync novel sources" @click="syncLncrawl">
                <Icon name="refresh" :class="{ 'sp-spin': busy }" />
              </button>
              <button v-if="lncrawlStatus.managed" class="sp-btn ghost sm" @click="stopLncrawl">Stop</button>
            </div>
          </div>
          <div v-if="!lncrawlStatus?.running" class="sp-muted" style="font-size: 11px; line-height: 1.4">
            <template v-if="lncrawlStatus?.installed">
              Installed locally. Click Auto-setup to start lightnovel-crawler novel sources.
            </template>
            <template v-else>
              Installs lightnovel-crawler in an isolated environment for 300+ novel sources (Python/uv is installed automatically if missing).
            </template>
          </div>
        </div>

        <div class="sp-card">
          <div class="sp-row">
            <div style="min-width: 0">
              <div class="sp-title">LNReader (Novels)</div>
              <div class="sp-muted">
                {{ lnreaderStatus?.enabled ? `Enabled (${lnreaderStatus.pluginCount} plugins)` : 'Disabled' }}
              </div>
            </div>
            <button v-if="!lnreaderStatus?.enabled" class="sp-btn primary sm" :disabled="syncingLnreader" @click="syncLnreader">
              <Icon name="download" :class="{ 'sp-spin': syncingLnreader }" />
              {{ syncingLnreader ? 'Syncing…' : 'Enable & Sync' }}
            </button>
            <div v-else class="sp-row" style="gap: 6px">
              <button class="sp-btn sm" :disabled="syncingLnreader" title="Refresh LNReader plugins" @click="syncLnreader">
                <Icon name="refresh" :class="{ 'sp-spin': syncingLnreader }" />
              </button>
              <button class="sp-btn ghost sm" @click="disableLnreader">Disable</button>
            </div>
          </div>
          <div v-if="!lnreaderStatus?.enabled" class="sp-muted" style="font-size: 11px; line-height: 1.4">
            Adds 200+ English LNReader JS novel plugins (runs directly in Node.js, no extra runtime needed).
          </div>
        </div>

        <div class="sp-card">
          <div class="sp-section-title">Notifications</div>
          <div>
            <label v-for="opt in NOTIFICATION_OPTIONS" :key="opt.key" class="sp-setting-row">
              <span class="sp-setting-info">
                <span class="sp-setting-label">{{ opt.label }}</span>
                <span class="sp-setting-desc">{{ opt.description }}</span>
              </span>
              <input type="checkbox" :checked="notifications[opt.key]" @change="toggleNotification(opt.key)" />
            </label>
          </div>
        </div>

        <div class="sp-card">
          <div class="sp-row">
            <div style="min-width: 0">
              <div class="sp-title">Updates</div>
              <div class="sp-muted">
                <template v-if="updateStatus">
                  v{{ updateStatus.currentVersion }}<template v-if="updateStatus.currentCommit"> ({{ updateStatus.currentCommit }})</template>
                  <template v-if="updateStatus.updateAvailable">
                    — Update available<template v-if="updateStatus.latestCommit"> ({{ updateStatus.latestCommit }})</template>
                  </template>
                  <template v-else-if="updateStatus.error"> — {{ updateStatus.error }}</template>
                  <template v-else> — Up to date</template>
                </template>
                <template v-else>Check GitHub for new releases</template>
              </div>
            </div>
            <div class="sp-row" style="gap: 6px">
              <button class="sp-btn sm" :disabled="checkingUpdate" title="Check for updates" @click="checkUpdates(true)">
                <Icon name="refresh" :class="{ 'sp-spin': checkingUpdate }" />
              </button>
              <button
                v-if="updateStatus?.updateAvailable && updateStatus.canAutoUpdate"
                class="sp-btn primary sm"
                :disabled="applyingUpdate"
                @click="applyUpdateNow"
              >
                <Icon name="download" :class="{ 'sp-spin': applyingUpdate }" />
                {{ applyingUpdate ? 'Updating…' : 'Update' }}
              </button>
              <a
                v-else-if="updateStatus?.updateAvailable"
                class="sp-btn primary sm"
                :href="updateStatus.downloadUrl"
                target="_blank"
                rel="noopener"
              >
                <Icon name="download" />
                Download ZIP
              </a>
            </div>
          </div>
          <div v-if="updateStatus?.updateAvailable && updateStatus.latestMessage" class="sp-muted" style="font-size: 11px; margin-top: 6px">
            Latest: {{ updateStatus.latestMessage }}
          </div>
          <div v-if="updateMessage" class="sp-muted" style="font-size: 11px; margin-top: 6px; color: var(--sp-accent, #7dd3fc)">
            {{ updateMessage }}
          </div>
        </div>

        <div class="sp-card">
          <div class="sp-row">
            <div style="min-width: 0">
              <div class="sp-title">AtsuSync Server</div>
              <div class="sp-muted">Stop the local server and close its terminal</div>
            </div>
            <button class="sp-btn danger" :disabled="stoppingServer" @click="stopServer">
              <Icon name="power" />
              {{ stoppingServer ? 'Stopping…' : 'Stop Server' }}
            </button>
          </div>
        </div>
      </template>
    </main>
    <div v-if="error" class="sp-toast-stack">
      <AlertBanner kind="error" prefix="sp" variant="toast" dismissible :message="error" @dismiss="error = null" />
    </div>
    </template>
  </div>
</template>
