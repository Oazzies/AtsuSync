import { randomUUID } from 'node:crypto';
import type { AtsuSeriesState } from '@atsusync/shared';
import { USER_AGENT, retryAfterMs, sleep } from '../polite.ts';

export const ATSU_BASE = 'https://atsu.moe';
export const CONTENT_REQUESTS_FORUM_ID = 'cms0o0eh80000uj0lmpkut6tc';
export const CONTENT_REQUESTS_PATH = '/social/forum/cms0o0eh80000uj0lmpkut6tc/content-requests';

export interface AtsuTag {
  id: string;
  name: string;
  emoji: string | null;
  modOnly?: boolean;
  terminal?: boolean;
}

export interface AtsuPost {
  id: string;
  forumId: string;
  title: string;
  content: string;
  sectionId?: string;
  commentCount: number;
  score: number;
  pinned: boolean;
  locked: boolean;
  removed: boolean;
  createdAt: number;
  author?: { usernameDisplay?: string } | null;
  tags?: AtsuTag[];
}

export interface AtsuPostsPage {
  posts: AtsuPost[];
  hasMore: boolean;
}

export interface SeriesRef {
  mangaId?: string | null;
  mangaBakaId?: string | null;
}

export interface CreateDraftInput {
  sourceId: string;
  number: number;
  title: string | null;
  /** sha256 of each page, in reading order. */
  pageOrder: string[];
}

export interface SubmitResult {
  id: string;
  /** null = the draft was not accepted; `message` says why. */
  status: string | null;
  message?: string | null;
}

export interface AtsuComment {
  id: string;
  content: string;
  createdAt: number;
  removed: boolean;
  score: number;
  parentId: string | null;
  user: { usernameDisplay: string; usernameSlug: string } | null;
  replies?: AtsuComment[];
}

/** One hit from Atsumaru's public series search (Typesense). */
export interface AtsuSearchHit {
  id: string;
  title: string;
  otherNames: string[];
  chapterCount: number;
  dateAdded: number | null;
  type: string | null;
  /** "Comic" or "Novel". */
  medium: string | null;
  isAdult: boolean;
}

/** A series page on atsu.moe, from the public search index. */
export interface AtsuSeriesInfo {
  id: string;
  title: string;
  altTitles: string[];
  synopsis: string;
  cover: string | null;
  chapterCount: number;
  medium: string | null;
}

export class AtsuError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * Thin client over atsu.moe's JSON API. Auth is the user's browser session cookie.
 *
 * Endpoints mirror what the site's own /upload page does (Hono RPC under /api/uploads):
 *   source (series + optional group) → draft (number, title, page sha256 order)
 *   → PUT each page by sha256 → submit drafts for review.
 */
export class AtsuClient {
  /** Requests to atsu.moe are spaced at least this far apart (page uploads included). */
  private minIntervalMs = 350;
  private nextAt = 0;

  constructor(
    private getCookie: () => string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async turn() {
    const wait = this.nextAt - Date.now();
    this.nextAt = Math.max(Date.now(), this.nextAt) + this.minIntervalMs;
    if (wait > 0) await sleep(wait);
  }

  private async request(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    await this.turn();
    const headers = new Headers(init.headers);
    headers.set('user-agent', USER_AGENT);
    const cookie = this.getCookie().trim();
    if (cookie) headers.set('cookie', cookie);
    headers.set('accept', headers.get('accept') ?? 'application/json');
    headers.set('origin', ATSU_BASE);
    headers.set('referer', `${ATSU_BASE}/upload`);
    const res = await this.fetchImpl(`${ATSU_BASE}${path}`, { ...init, headers });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const backoff = 1000 * 2 ** attempt * (0.75 + Math.random() * 0.5);
      const wait = Math.max(backoff, retryAfterMs(res) ?? 0);
      this.nextAt = Math.max(this.nextAt, Date.now() + wait);
      await sleep(wait);
      return this.request(path, init, attempt + 1);
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) throw new AtsuError(`${init?.method ?? 'GET'} ${path} → ${res.status} ${await safeText(res)}`, res.status);
    return (await res.json()) as T;
  }

  // ---- Forum ----

  listPosts(page: number, sort: 'new' | 'hot' = 'new', forumId = CONTENT_REQUESTS_FORUM_ID) {
    const q = new URLSearchParams({ forumId, sort, page: String(page) });
    return this.json<AtsuPostsPage>(`/api/forum/posts?${q}`);
  }

  async getPost(postId: string): Promise<AtsuPost | null> {
    const r = await this.json<{ post?: AtsuPost }>(`/api/forum/getPost?postId=${encodeURIComponent(postId)}`);
    return r.post ?? null;
  }

  /** Comment threads under a forum post, newest first, flattened with replies. */
  async getComments(sectionId: string): Promise<AtsuComment[]> {
    const q = new URLSearchParams({ sectionId, maxDepth: '3', sort: 'new' });
    const r = await this.json<{ comments?: AtsuComment[] }>(`/api/comments/v2/threads?${q}`);
    const out: AtsuComment[] = [];
    const walk = (list: AtsuComment[] = []) =>
      list.forEach((c) => {
        out.push({ ...c, replies: undefined });
        walk(c.replies);
      });
    walk(r.comments);
    return out;
  }

  /** Atsumaru's public series search (no login needed). */
  async searchPublic(q: string, limit = 5): Promise<AtsuSearchHit[]> {
    const params = new URLSearchParams({ q, query_by: 'title,englishTitle,otherNames', limit: String(limit) });
    const r = await this.json<{ hits?: { document: Record<string, any> }[] }>(`/collections/manga/documents/search?${params}`);
    return (r.hits ?? []).map(({ document: d }) => ({
      id: String(d.id),
      title: String(d.title ?? d.englishTitle ?? ''),
      otherNames: Array.isArray(d.otherNames) ? d.otherNames : [],
      chapterCount: Number(d.chapterCount ?? 0),
      dateAdded: typeof d.dateAdded === 'number' ? d.dateAdded : null,
      type: d.type ?? null,
      medium: d.medium ?? null,
      isAdult: !!d.isAdult,
    }));
  }

  /** One series from the public search index by its Atsumaru id (no login needed), or null when it doesn't exist. */
  async getSeriesInfo(mangaId: string): Promise<AtsuSeriesInfo | null> {
    const params = new URLSearchParams({ q: '*', query_by: 'title', filter_by: `id:=${mangaId}`, limit: '1' });
    const r = await this.json<{ hits?: { document: Record<string, any> }[] }>(`/collections/manga/documents/search?${params}`);
    const d = r.hits?.[0]?.document;
    if (!d) return null;
    const poster = d.posterMedium ?? d.poster;
    return {
      id: String(d.id),
      title: String(d.title ?? d.englishTitle ?? ''),
      altTitles: Array.isArray(d.otherNames) ? d.otherNames : [],
      synopsis: typeof d.synopsis === 'string' ? d.synopsis : '',
      cover: typeof poster === 'string' ? (poster.startsWith('http') ? poster : `${ATSU_BASE}${poster}`) : null,
      chapterCount: Number(d.chapterCount ?? 0),
      medium: d.medium ?? null,
    };
  }

  async listTags(forumId = CONTENT_REQUESTS_FORUM_ID) {
    const r = await this.json<{ tags: AtsuTag[] }>(`/api/forum/tags?forumId=${encodeURIComponent(forumId)}`);
    return r.tags;
  }

  // ---- Account ----

  /** Returns the logged-in username, or null when the cookie is missing/expired. */
  async whoAmI(): Promise<string | null> {
    if (!this.getCookie().trim()) return null;
    const res = await this.request('/api/auth/me');
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Record<string, any> | null;
    const user = body?.me ?? body?.user ?? body;
    return user?.usernameDisplay ?? user?.username ?? user?.usernameSlug ?? null;
  }

  // ---- Uploads (read) ----

  getUploadWorkspace() {
    return this.json<unknown>('/api/uploads');
  }

  searchSeries(q: string) {
    return this.json<unknown>(`/api/uploads/series/search?q=${encodeURIComponent(q)}`);
  }

  async getSeriesState(ref: SeriesRef): Promise<AtsuSeriesState> {
    const q = ref.mangaId ? `mangaId=${encodeURIComponent(ref.mangaId)}` : `mangaBakaId=${encodeURIComponent(ref.mangaBakaId ?? '')}`;
    const res = await this.request(`/api/uploads/series?${q}`);
    if (!res.ok) {
      return { ...emptySeriesState(), error: res.status === 401 ? 'Not logged in to Atsumaru (set the cookie in Settings)' : `${res.status} ${await safeText(res)}` };
    }
    return parseSeriesState(await res.json());
  }

  // ---- Uploads (write) ----

  /** Mapped from the site bundle: PUT raw page bytes into a draft, keyed by sha256. */
  async putPage(draftId: string, sha256: string, name: string, bytes: Uint8Array) {
    const path = `/api/uploads/${encodeURIComponent(draftId)}/pages/${sha256}?name=${encodeURIComponent(name)}`;
    const res = await this.request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes as Uint8Array<ArrayBuffer>,
    });
    if (!res.ok) throw new AtsuError(`PUT page ${name} → ${res.status} ${await safeText(res)}`, res.status);
  }

  /** Reuse the user's upload source for this series (same group), or create one. */
  async ensureSource(ref: SeriesRef, groupId: string | null): Promise<string> {
    const state = await this.json<{ sources?: { id: string; groupId?: string | null; provider?: string }[] }>(
      `/api/uploads/series?${ref.mangaId ? `mangaId=${encodeURIComponent(ref.mangaId)}` : `mangaBakaId=${encodeURIComponent(ref.mangaBakaId ?? '')}`}`,
    );
    const existing = (state.sources ?? []).find((s) => (s.provider ?? 'Manual') === 'Manual' && (s.groupId ?? null) === groupId);
    if (existing) return existing.id;
    if (!ref.mangaId && !ref.mangaBakaId) throw new AtsuError('Need a mangaId or MangaBaka id to create an upload source');
    const body = { id: randomUUID(), groupId, ...(ref.mangaId ? { mangaId: ref.mangaId } : { mangaBakaId: ref.mangaBakaId }) };
    const res = await this.json<{ source: { id: string } }>('/api/uploads/sources', jsonInit('POST', body));
    return res.source.id;
  }

  async createDraft(input: CreateDraftInput): Promise<{ draftId: string }> {
    const body = { id: randomUUID(), ...input, replaceChapterId: null };
    const res = await this.json<{ draft: { id: string } }>('/api/uploads/drafts', jsonInit('POST', body));
    return { draftId: res.draft?.id ?? body.id };
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.request(`/api/uploads/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
  }

  /** Submit drafts for review. Throws if Atsumaru didn't accept one. */
  async submitDraft(draftId: string): Promise<SubmitResult> {
    const res = await this.json<{ results: SubmitResult[] }>('/api/uploads/drafts/submit', jsonInit('POST', { ids: [draftId] }));
    const result = res.results?.find((r) => r.id === draftId) ?? res.results?.[0];
    if (!result || result.status === null) throw new AtsuError(`Submit rejected: ${result?.message ?? 'no result returned'}`);
    return result;
  }
}

export const emptySeriesState = (): AtsuSeriesState => ({
  found: false,
  mangaId: null,
  mangaBakaId: null,
  title: null,
  ranges: [],
  waiting: [],
  total: 0,
  latest: null,
  mySourceIds: [],
  others: [],
});

/** Shape of GET /api/uploads/series: { series, coverage: { out, waiting, total }, sources, elsewhere }. */
export function parseSeriesState(body: any): AtsuSeriesState {
  const series = body?.series;
  if (!series) return emptySeriesState();
  const ranges = toRanges(body.coverage?.out);
  return {
    found: !!series.mangaId,
    mangaId: series.mangaId ?? null,
    mangaBakaId: series.mangaBakaId ?? null,
    title: series.title ?? null,
    ranges,
    waiting: toRanges(body.coverage?.waiting),
    total: Number(body.coverage?.total ?? 0),
    latest: ranges.length ? Math.max(...ranges.map((r) => r[1])) : null,
    mySourceIds: (body.sources ?? []).map((s: { id: string }) => s.id),
    others: (body.elsewhere ?? []).map((e: any) => ({
      id: String(e.id),
      label: String(e.label ?? ''),
      manual: !!e.manual,
      chapters: Number(e.chapters ?? 0),
      latest: e.latest ?? null,
      pending: Number(e.pending ?? 0),
    })),
  };
}

const toRanges = (v: unknown): [number, number][] =>
  Array.isArray(v) ? v.filter((r) => Array.isArray(r) && r.length === 2).map((r) => [Number(r[0]), Number(r[1])] as [number, number]) : [];

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const safeText = async (res: Response) => (await res.text().catch(() => '')).slice(0, 300);
