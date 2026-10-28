import { onUnmounted, ref } from 'vue';
import type {
  AtsuPresence,
  AtsuSeriesState,
  RequestComment,
  ContentRequest,
  DownloadJob,
  Link,
  LinkChapter,
  ServerEvent,
  Settings,
  SettingsView,
  SourceInfo,
  SourceMatch,
  SourceChapter,
  SourceSeriesHit,
} from '@atsusync/shared';

export interface MangaBaka {
  id: number;
  title: string;
  titles: string[];
  cover: string | null;
  type: string | null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
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
  comments: (id: string) => call<RequestComment[]>('GET', `/requests/${id}/comments`),
  checkPresence: (id: string) => call<AtsuPresence>('POST', `/requests/${id}/presence`),
  findSources: (id: string) => call<SourceMatch[]>('POST', `/requests/${id}/find-sources`),
  addSource: (id: string, url: string) => call<SourceMatch>('POST', `/requests/${id}/add-source`, { url }),

  sources: () => call<SourceInfo[]>('GET', '/sources'),
  setSourceEnabled: (id: string, enabled: boolean) => call<SourceInfo[]>('PUT', `/sources/${id}`, { enabled }),
  testSource: (id: string, query: string) => call<{ ok: boolean; hits: SourceSeriesHit[]; ms: number }>('POST', `/sources/${id}/test`, { query }),

  links: () => call<Link[]>('GET', '/links'),
  createLink: (requestId: string, sourceId: string, seriesUrl: string) => call<Link>('POST', '/links', { requestId, sourceId, seriesUrl }),
  link: (id: number) => call<{ link: Link; atsu: AtsuSeriesState | null; chapters: LinkChapter[] }>('GET', `/links/${id}`),
  updateLink: (id: number, patch: { watch?: boolean; checkIntervalMin?: number; atsuMangaId?: string | null }) =>
    call<Link>('PATCH', `/links/${id}`, patch),
  deleteLink: (id: number) => call<{ ok: true }>('DELETE', `/links/${id}`),
  searchOtherSources: (id: number, q?: string) =>
    call<{ sourceId: string; sourceName: string; hits: SourceSeriesHit[]; error: string | null }[]>(
      'GET',
      `/links/${id}/search-sources${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    ),
  otherSeries: (id: number, url: string) =>
    call<{ sourceName: string; title: string; url: string; chapters: (SourceChapter & { inLink: boolean })[] }>(
      'GET',
      `/links/${id}/other-series?url=${encodeURIComponent(url)}`,
    ),
  fetchFrom: (id: number, url: string, numbers: number[]) => call<DownloadJob[]>('POST', `/links/${id}/fetch-from`, { url, numbers }),
  checkLink: (id: number) => call<{ added: number; link: Link }>('POST', `/links/${id}/check`),
  setChapterState: (chapterIds: number[], state: 'skipped' | 'known' | 'pending' | 'uploaded') =>
    call<{ ok: true }>('POST', '/chapters/state', { chapterIds, state }),

  downloads: (linkId?: number) => call<DownloadJob[]>('GET', linkId === undefined ? '/downloads' : `/downloads?linkId=${linkId}`),
  download: (chapterIds: number[]) => call<DownloadJob[]>('POST', '/downloads', { chapterIds }),
  clearDownloads: (linkId: number) => call<{ jobs: number; files: number }>('DELETE', `/downloads?linkId=${linkId}`),
  retryDownload: (id: number) => call<DownloadJob>('POST', `/downloads/${id}/retry`),
  cancelDownload: (id: number) => call<DownloadJob>('POST', `/downloads/${id}/cancel`),
  downloadFileUrl: (id: number) => `/api/downloads/${id}/file`,

  // Hand-built chapters
  createDraft: () => call<DraftView>('POST', '/manual/drafts'),
  discardDraft: (id: string) => call<{ ok: true }>('DELETE', `/manual/drafts/${id}`),
  addDraftPage: async (id: string, file: File): Promise<DraftView> => {
    const res = await fetch(`/api/manual/drafts/${id}/pages?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
    return data as DraftView;
  },
  updateDraft: (id: string, patch: { order?: string[]; joins?: Record<string, boolean>; sortByName?: boolean }) =>
    call<DraftView>('PUT', `/manual/drafts/${id}`, patch),
  removeDraftPage: (id: string, pageId: string) => call<DraftView>('DELETE', `/manual/drafts/${id}/pages/${pageId}`),
  draftPageUrl: (id: string, pageId: string) => `/api/manual/drafts/${id}/pages/${pageId}/image`,
  draftPreview: (id: string, autoJoin: boolean) => call<DraftPreviewPage[]>('GET', `/manual/drafts/${id}/preview?autoJoin=${autoJoin ? 1 : 0}`),
  draftPreviewUrl: (id: string, index: number, autoJoin: boolean, v: number) =>
    `/api/manual/drafts/${id}/preview/${index}?autoJoin=${autoJoin ? 1 : 0}&v=${v}`,
  commitDraft: (id: string, body: { linkId: number; number: number; label: string; autoJoin: boolean }) =>
    call<DownloadJob>('POST', `/manual/drafts/${id}/commit`, body),
};

export interface DraftPage {
  id: string;
  name: string;
  width: number;
  height: number;
  size: number;
  joinPrev: boolean;
}
export interface DraftView {
  id: string;
  pages: DraftPage[];
}
export interface DraftPreviewPage {
  index: number;
  name: string;
  width: number;
  height: number;
  parts: number;
}

// ---- Server-sent events: one shared EventSource for the whole app ----
type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
export const connected = ref(false);

function ensureSource() {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => (connected.value = true);
  source.onerror = () => (connected.value = false);
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data) as ServerEvent;
    listeners.forEach((l) => l(e));
  };
}

/** Subscribe to server events for the lifetime of the calling component. */
export function useServerEvents(fn: Listener) {
  ensureSource();
  listeners.add(fn);
  onUnmounted(() => listeners.delete(fn));
}

export function useAsync<T>(loader: () => Promise<T>) {
  const data = ref<T | null>(null);
  const error = ref<string | null>(null);
  const loading = ref(false);
  async function run() {
    loading.value = true;
    error.value = null;
    try {
      data.value = (await loader()) as never;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }
  return { data, error, loading, run };
}

export const fmtRanges = (ranges: [number, number][]) => ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');

export const fmtAgo = (ts: number | null) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
