<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Link, SettingsView, SourceInfo, SuwayomiExtensionInfo, SuwayomiStatus } from '@atsusync/shared';
import { api, START_SERVER_URL, syncCookiesNow, useServerEvents, waitForServerOnline } from '../api';
import Icon from '../ui/Icon.vue';

const tab = ref<'tracked' | 'sources'>('tracked');
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

// Keiyoushi / Suwayomi state
const suwayomiStatus = ref<SuwayomiStatus | null>(null);
const settingUpSuwayomi = ref(false);
const showExtensions = ref(false);
const loadingExtensions = ref(false);
const extensions = ref<SuwayomiExtensionInfo[]>([]);
const extSearch = ref('');
const sourceSearch = ref('');
const busyPkg = ref<Record<string, boolean>>({});

const filteredExtensions = computed(() => {
  const q = extSearch.value.trim().toLowerCase();
  return extensions.value.filter((e) =>
    !q ? true : e.name.toLowerCase().includes(q) || e.pkgName.toLowerCase().includes(q),
  );
});

const filteredSources = computed(() => {
  const q = sourceSearch.value.trim().toLowerCase();
  return sources.value.filter((s) =>
    !q ? true : s.name.toLowerCase().includes(q) || s.kind.toLowerCase().includes(q),
  );
});

// Active tab context for smart Tracked filtering
const activeTabUrl = ref<string | null>(null);
const activeRequestId = ref<string | null>(null);
const activeMangaId = ref<string | null>(null);
const showAllOnPage = ref(false);
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
    const [s, l, src, sw] = await Promise.all([
      api.settings(),
      api.links(),
      api.sources(),
      api.suwayomiStatus().catch(() => null),
    ]);
    online.value = true;
    settings.value = s;
    links.value = l;
    sources.value = src;
    suwayomiStatus.value = sw;
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 0) online.value = false;
    error.value = err.message;
  }
}

async function syncActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  await updateActiveContext(active?.url);
}

function onTabActivated() {
  void syncActiveTab();
}

function onTabUpdated(_tabId: number, changeInfo: { url?: string; status?: string }, tabInfo: chrome.tabs.Tab) {
  if (tabInfo.active && (changeInfo.url || changeInfo.status === 'complete')) {
    void updateActiveContext(changeInfo.url ?? tabInfo.url);
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

onMounted(() => {
  connectSidePanelPort();
  void load(false);
  void syncActiveTab();
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
});

onUnmounted(() => {
  sidePanelPort?.disconnect();
  sidePanelPort = null;
  chrome.tabs.onActivated.removeListener(onTabActivated);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);
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

async function summonDock() {
  error.value = null;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== undefined && active.url?.startsWith('https://atsu.moe/')) {
    await chrome.tabs.sendMessage(active.id, { type: 'summonDock' }).catch(() => {
      error.value = 'Reload the atsu.moe tab to connect the floating window.';
    });
  } else {
    error.value = 'Open an atsu.moe tab first to summon the floating window.';
  }
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
    await load(false);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="sp-shell">
    <div v-if="online === false" class="sp-offline-screen">
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
    <header class="sp-header">
      <div class="sp-brand">
        <span class="sp-wordmark">Atsu<span>Sync</span></span>
        <span v-if="!online" class="sp-badge red">Offline</span>
      </div>
      <div class="sp-header-actions">
        <span v-if="settings?.atsuUser" class="sp-badge green sp-user-chip" :title="settings.atsuUser">
          {{ settings.atsuUser }}
        </span>
        <button class="sp-btn sm" title="Summon floating window on atsu.moe" @click="summonDock">
          <Icon name="panel" />
          <span>Window</span>
        </button>
        <button class="sp-btn sm" :disabled="busy" title="Refresh" @click="load(true)">
          <Icon name="refresh" :class="{ 'sp-spin': busy }" />
        </button>
      </div>
    </header>

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
      </div>
    </div>

    <main class="sp-body">
      <div v-if="error" class="sp-error">{{ error }}</div>

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
              <div v-if="l.missingCount || l.pendingCount" class="sp-badges">
                <span v-if="l.missingCount" class="sp-badge amber">{{ l.missingCount }} missing</span>
                <span v-if="l.pendingCount" class="sp-badge indigo">{{ l.pendingCount }} new</span>
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
          <div class="sp-row">
            <div style="min-width: 0">
              <div class="sp-title">Keiyoushi / Suwayomi</div>
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

          <div v-if="showExtensions" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px">
            <input v-model="extSearch" class="sp-input" type="search" placeholder="Search English Keiyoushi extensions…" />
            <div v-if="loadingExtensions" class="sp-muted">Loading extension catalog…</div>
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
          <div class="sp-row" style="margin-bottom: 8px">
            <div class="sp-section-title" style="margin: 0">
              Sources ({{ filteredSources.length }}<span v-if="sourceSearch.trim()"> / {{ sources.length }}</span>)
            </div>
          </div>
          <input v-model="sourceSearch" class="sp-input" type="search" placeholder="Filter sources…" style="margin-bottom: 8px" />
          <div style="max-height: 360px; overflow-y: auto">
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
    </main>
    </template>
  </div>
</template>
