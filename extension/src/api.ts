import { onUnmounted } from 'vue';
import type {
  AtsuPresence,
  AtsuSeriesState,
  ContentRequest,
  DownloadJob,
  Link,
  LinkChapter,
  MangaBaka,
  ServerEvent,
  Settings,
  SettingsView,
  SourceInfo,
  SourceMatch,
  SourceSeriesHit,
} from '@atsusync/shared';

export type BgRequest =
  | { type: 'api'; method: string; path: string; body?: unknown }
  | { type: 'syncCookies' }
  | { type: 'openSidePanel' };

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

export function syncCookiesNow(): Promise<SettingsView> {
  return chrome.runtime.sendMessage({ type: 'syncCookies' } satisfies BgRequest).then((res: BgResponse<SettingsView>) => {
    if (!res?.ok) throw new Error(res?.error ?? 'Cookie sync failed');
    return res.data;
  });
}

export function openSidePanel(): void {
  void chrome.runtime.sendMessage({ type: 'openSidePanel' } satisfies BgRequest);
}

export const api = {
  settings: () => call<SettingsView>('GET', '/settings'),
  saveSettings: (patch: Partial<Settings>) => call<SettingsView>('PUT', '/settings', patch),

  requests: () => call<ContentRequest[]>('GET', '/requests'),
  syncRequests: (full = false) => call<{ added: number; updated: number }>('POST', `/requests/sync${full ? '?full=1' : ''}`),
  request: (id: string) =>
    call<{ request: ContentRequest; mangabaka: MangaBaka | null; matches: SourceMatch[]; links: Link[] }>('GET', `/requests/${id}`),
  addSeries: (url: string) => call<ContentRequest>('POST', '/series', { url }),
  requestAtsu: (id: string) => call<AtsuSeriesState>('GET', `/requests/${id}/atsu`),
  checkPresence: (id: string) => call<AtsuPresence>('POST', `/requests/${id}/presence`),
  findSources: (id: string) => call<SourceMatch[]>('POST', `/requests/${id}/find-sources`),
  checkMangaBaka: (id: string) => call<{ mangabaka: MangaBaka | null; mediumMismatch: boolean }>('POST', `/requests/${id}/mangabaka`),
  addSource: (id: string, url: string) => call<SourceMatch>('POST', `/requests/${id}/add-source`, { url }),

  sources: () => call<SourceInfo[]>('GET', '/sources'),
  setSourceEnabled: (id: string, enabled: boolean) => call<SourceInfo[]>('PUT', `/sources/${id}`, { enabled }),
  testSource: (id: string, query: string) => call<{ ok: boolean; hits: SourceSeriesHit[]; ms: number }>('POST', `/sources/${id}/test`, { query }),

  links: () => call<Link[]>('GET', '/links'),
  createLink: (requestId: string, sourceId: string, seriesUrl: string) => call<Link>('POST', '/links', { requestId, sourceId, seriesUrl }),
  link: (id: number) => call<{ link: Link; atsu: AtsuSeriesState | null; mangabaka: MangaBaka | null; chapters: LinkChapter[] }>('GET', `/links/${id}`),
  updateLink: (id: number, patch: { watch?: boolean; checkIntervalMin?: number; atsuMangaId?: string | null }) =>
    call<Link>('PATCH', `/links/${id}`, patch),
  deleteLink: (id: number) => call<{ ok: true }>('DELETE', `/links/${id}`),
  checkLink: (id: number) => call<{ added: number; link: Link }>('POST', `/links/${id}/check`),
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
