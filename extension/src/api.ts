import { onUnmounted, ref } from 'vue';
import type {
  AtsuPresence,
  AtsuSeriesInfo,
  AtsuSeriesState,
  ContentRequest,
  DownloadJob,
  Link,
  LinkChapter,
  LncrawlStatus,
  LnreaderStatus,
  MangaBaka,
  ServerEvent,
  Settings,
  SettingsView,
  SourceInfo,
  SourceMatch,
  SourceSearchFilter,
  SourceSeriesHit,
  SuwayomiExtensionInfo,
  SuwayomiStatus,
} from '@atsusync/shared';

export type BgRequest =
  | { type: 'api'; method: string; path: string; body?: unknown }
  | { type: 'fetchCover'; url: string }
  | { type: 'syncCookies' }
  | { type: 'toggleSidePanel' }
  | { type: 'getSidePanelState' };

export type BgResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = (await chrome.runtime.sendMessage({
    type: 'api',
    method,
    path,
    body,
  } satisfies BgRequest)) as BgResponse<T>;
  if (!res) throw new Error('AtsuSync extension background did not respond');
  if (!res.ok) {
    const err = new Error(res.error) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.data;
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function fetchDownloadFile(jobId: number): Promise<{ bytes: Uint8Array; filename: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'fetchFile' });
    let filename = 'chapter.zip';
    let mime = 'application/zip';
    let totalBytes = 0;
    const chunks: Uint8Array[] = [];
    let settled = false;

    const fail = (err: string) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      reject(new Error(err));
    };

    port.onMessage.addListener(
      (msg: { type: 'meta'; filename: string; mime: string; totalBytes: number } | { type: 'chunk'; b64: string } | { type: 'end' } | { type: 'error'; error: string }) => {
        if (msg.type === 'meta') {
          filename = msg.filename;
          mime = msg.mime;
          totalBytes = msg.totalBytes;
        } else if (msg.type === 'chunk') {
          chunks.push(base64ToUint8(msg.b64));
        } else if (msg.type === 'end') {
          if (settled) return;
          settled = true;
          const size = totalBytes || chunks.reduce((s, c) => s + c.byteLength, 0);
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const c of chunks) {
            bytes.set(c, offset);
            offset += c.byteLength;
          }
          try {
            port.disconnect();
          } catch {
            /* ignore */
          }
          resolve({ bytes, filename, mime });
        } else if (msg.type === 'error') {
          fail(msg.error);
        }
      },
    );

    port.onDisconnect.addListener(() => {
      if (!settled) fail(chrome.runtime.lastError?.message ?? 'Failed to fetch ZIP');
    });

    port.postMessage({ path: `/downloads/${jobId}/file` });
  });
}

export function fetchCoverDataUrl(url: string): Promise<string> {
  return chrome.runtime.sendMessage({ type: 'fetchCover', url } satisfies BgRequest).then((res: BgResponse<string>) => {
    if (!res?.ok) throw new Error(res?.error ?? 'Failed to fetch cover');
    return res.data;
  });
}

/** Resolves `http://` (e.g. local Suwayomi) cover URLs into `data:` URLs via the background worker. */
export function useCoverResolver() {
  const resolved = ref<Record<string, string>>({});
  const failed = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];
  let active = 0;
  const MAX_CONCURRENT = 6;

  function pump() {
    while (active < MAX_CONCURRENT && queue.length > 0) {
      const url = queue.shift()!;
      active++;
      void fetchCoverDataUrl(url)
        .then((dataUrl) => {
          resolved.value = { ...resolved.value, [url]: dataUrl };
        })
        .catch(() => {
          failed.add(url);
        })
        .finally(() => {
          queued.delete(url);
          active--;
          pump();
        });
    }
  }

  function preload(urls: Iterable<string | null | undefined>) {
    let added = false;
    for (const url of urls) {
      if (!url || !url.startsWith('http://')) continue;
      if (resolved.value[url] || failed.has(url) || queued.has(url)) continue;
      queued.add(url);
      queue.push(url);
      added = true;
    }
    if (added) pump();
  }

  function coverSrc(url: string | null | undefined): string | null {
    if (!url) return null;
    if (!url.startsWith('http://')) return url;
    return resolved.value[url] ?? null;
  }

  function reset() {
    resolved.value = {};
    failed.clear();
    queued.clear();
    queue.length = 0;
  }

  return { coverSrc, preload, reset };
}

export function syncCookiesNow(): Promise<SettingsView> {
  return chrome.runtime.sendMessage({ type: 'syncCookies' } satisfies BgRequest).then((res: BgResponse<SettingsView>) => {
    if (!res?.ok) throw new Error(res?.error ?? 'Cookie sync failed');
    return res.data;
  });
}

export function toggleSidePanel(): void {
  void chrome.runtime.sendMessage({ type: 'toggleSidePanel' } satisfies BgRequest);
}

export function getSidePanelState(): Promise<boolean> {
  return chrome.runtime
    .sendMessage({ type: 'getSidePanelState' } satisfies BgRequest)
    .then((res: BgResponse<boolean>) => (res?.ok ? res.data : false))
    .catch(() => false);
}

export const api = {
  settings: () => call<SettingsView>('GET', '/settings'),
  saveSettings: (patch: Partial<Settings>) => call<SettingsView>('PUT', '/settings', patch),
  stopServer: () => call<{ ok: boolean }>('POST', '/server/stop'),

  requests: () => call<ContentRequest[]>('GET', '/requests'),
  request: (id: string) =>
    call<{ request: ContentRequest; mangabaka: MangaBaka | null; atsuSeries: AtsuSeriesInfo | null; matches: SourceMatch[]; links: Link[] }>('GET', `/requests/${id}`),
  updateRequestTitle: (id: string, title: string | null) => call<ContentRequest>('PATCH', `/requests/${id}`, { title }),
  deleteRequest: (id: string) => call<{ ok: true }>('DELETE', `/requests/${encodeURIComponent(id)}`),
  resolveUpload: (params: { sourceId?: string | null; mangaId?: string | null; mangaBakaId?: string | null; title?: string | null }) =>
    call<{
      request: ContentRequest | null;
      mangabaka: MangaBaka | null;
      atsuSeries: AtsuSeriesInfo | null;
      matches: SourceMatch[];
      links: Link[];
      resolved: { mangaId: string | null; mangaBakaId: string | null; title: string | null };
    }>('POST', '/uploads/resolve', params),
  addSeries: (url: string) => call<ContentRequest>('POST', '/series', { url }),
  requestAtsu: (id: string) => call<AtsuSeriesState>('GET', `/requests/${id}/atsu`),
  checkPresence: (id: string) => call<AtsuPresence>('POST', `/requests/${id}/presence`),
  findSources: (id: string, filter?: SourceSearchFilter) =>
    call<SourceMatch[]>('POST', `/requests/${id}/find-sources`, filter ? { filter } : undefined),
  stopFindSources: (id: string) =>
    call<{ stopped: boolean }>('POST', `/requests/${id}/stop-find-sources`),
  checkMangaBaka: (id: string) => call<{ mangabaka: MangaBaka | null; mediumMismatch: boolean }>('POST', `/requests/${id}/mangabaka`),
  addSource: (id: string, url: string) => call<SourceMatch>('POST', `/requests/${id}/add-source`, { url }),

  sources: () => call<SourceInfo[]>('GET', '/sources'),
  syncSuwayomi: () => call<{ count: number; sources: SourceInfo[] }>('POST', '/sources/suwayomi/sync'),
  suwayomiStatus: () => call<SuwayomiStatus>('GET', '/sources/suwayomi/status'),
  setupSuwayomi: () => call<{ status: SuwayomiStatus; count: number; sources: SourceInfo[] }>('POST', '/sources/suwayomi/setup'),
  stopSuwayomi: () => call<SuwayomiStatus>('POST', '/sources/suwayomi/stop'),
  suwayomiExtensions: () => call<{ extensions: SuwayomiExtensionInfo[] }>('GET', '/sources/suwayomi/extensions'),
  installSuwayomiExtension: (pkgName: string) =>
    call<{ count: number; sources: SourceInfo[] }>('POST', `/sources/suwayomi/extensions/${encodeURIComponent(pkgName)}/install`),
  uninstallSuwayomiExtension: (pkgName: string) =>
    call<{ count: number; sources: SourceInfo[] }>('POST', `/sources/suwayomi/extensions/${encodeURIComponent(pkgName)}/uninstall`),
  lncrawlStatus: () => call<LncrawlStatus>('GET', '/sources/lncrawl/status'),
  setupLncrawl: () => call<{ status: LncrawlStatus; count: number; sources: SourceInfo[] }>('POST', '/sources/lncrawl/setup'),
  syncLncrawl: () => call<{ count: number; sources: SourceInfo[] }>('POST', '/sources/lncrawl/sync'),
  stopLncrawl: () => call<LncrawlStatus>('POST', '/sources/lncrawl/stop'),
  lnreaderStatus: () => call<LnreaderStatus>('GET', '/sources/lnreader/status'),
  syncLnreader: () => call<{ status: LnreaderStatus; count: number; sources: SourceInfo[] }>('POST', '/sources/lnreader/sync'),
  disableLnreader: () => call<{ status: LnreaderStatus; sources: SourceInfo[] }>('POST', '/sources/lnreader/disable'),
  setSourceEnabled: (id: string, enabled: boolean) => call<SourceInfo[]>('PUT', `/sources/${id}`, { enabled }),
  testSource: (id: string, query: string) => call<{ ok: boolean; hits: SourceSeriesHit[]; ms: number }>('POST', `/sources/${id}/test`, { query }),

  links: () => call<Link[]>('GET', '/links'),
  createLink: (requestId: string, sourceId: string, seriesUrl: string) => call<Link>('POST', '/links', { requestId, sourceId, seriesUrl }),
  link: (id: number) => call<{ link: Link; atsu: AtsuSeriesState | null; mangabaka: MangaBaka | null; chapters: LinkChapter[] }>('GET', `/links/${id}`),
  updateLink: (id: number, patch: { watch?: boolean; checkIntervalMin?: number; atsuMangaId?: string | null }) =>
    call<Link>('PATCH', `/links/${id}`, patch),
  deleteLink: (id: number) => call<{ ok: true }>('DELETE', `/links/${id}`),
  checkLink: (id: number) => call<{ added: number; link: Link }>('POST', `/links/${id}/check`),
  refreshAtsu: (linkIds?: number[]) => call<{ updated: number; links: Link[] }>('POST', '/links/refresh-atsu', linkIds ? { linkIds } : {}),
  setChapterState: (chapterIds: number[], state: 'skipped' | 'known' | 'pending' | 'uploaded') =>
    call<{ ok: true }>('POST', '/chapters/state', { chapterIds, state }),

  downloads: (linkId?: number) => call<DownloadJob[]>('GET', linkId === undefined ? '/downloads' : `/downloads?linkId=${linkId}`),
  download: (chapterIds: number[]) => call<DownloadJob[]>('POST', '/downloads', { chapterIds }),
  clearDownloads: (linkId: number) => call<{ jobs: number; files: number }>('DELETE', `/downloads?linkId=${linkId}`),
  deleteDownload: (id: number) => call<{ jobs: number; files: number }>('DELETE', `/downloads/${id}`),
  retryDownload: (id: number) => call<DownloadJob>('POST', `/downloads/${id}/retry`),
  cancelDownload: (id: number) => call<DownloadJob>('POST', `/downloads/${id}/cancel`),
};

export function useServerEvents(onEvent: (ev: ServerEvent) => void): void {
  const listener = (msg: unknown) => {
    if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'serverEvent') {
      onEvent((msg as { event: ServerEvent }).event);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  onUnmounted(() => chrome.runtime.onMessage.removeListener(listener));
}

export const START_SERVER_URL = 'atsusync://start';

/** Polls the local server until it responds or the timeout/abort signal triggers. */
export async function waitForServerOnline(signal?: AbortSignal, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      await api.settings();
      return true;
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status !== 0) return true;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  return false;
}
