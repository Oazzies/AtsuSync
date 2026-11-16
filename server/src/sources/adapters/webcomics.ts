import * as cheerio from 'cheerio';
import type { SourceHttp } from '../http.ts';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

// WebComics (webcomicsapp.com). Series live at /en/<genre>/<slug>/<book_id> (or /en/comic/<slug>/<book_id>)
// and chapters at /en/<genre>/<slug>/<index>/<book_id>. The Nuxt frontend is backed by a JSON API at
// official-website-api.webcomicsapp.com. Paid chapters (is_pay && !is_paid) are marked `locked` and skipped.
const BASE = 'https://www.webcomicsapp.com';
const API = 'https://official-website-api.webcomicsapp.com';
const PAGE_SIZE = 200;
const MAX_CHAPTER_PAGES = 50;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export interface WcApiResponse<T> {
  code: number;
  data?: T;
  msg?: string;
}

export interface WcBookInfo {
  book_id: string;
  name: string;
  cover?: string;
  pic?: string;
  category?: string[];
  description?: string;
}

export interface WcChapterItem {
  index: number;
  chapter_id: string;
  name: string;
  cp_name_info?: string;
  is_pay?: boolean;
  is_paid?: boolean;
  is_preview?: boolean;
  update_time?: number;
}

export interface WcChapterListData {
  list?: WcChapterItem[];
  pagination?: { total?: number; page?: number; size?: number; next?: boolean };
}

export interface WcChapterDetail {
  base_url: string;
  images?: { url: string; width?: number; height?: number }[];
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'comic';

/** Extract the 24-hex-character book ID from a WebComics series or chapter URL. */
export function parseBookId(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts.length < 3) return null;
    const last = parts[parts.length - 1]!;
    return OBJECT_ID_RE.test(last) ? last.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function seriesUrl(book: Pick<WcBookInfo, 'book_id' | 'name' | 'category'>): string {
  const genre = slugify(book.category?.[0] ?? '');
  const slug = slugify(book.name);
  return `${BASE}/en/${genre}/${slug}/${book.book_id}`;
}

export function chapterUrl(
  book: Pick<WcBookInfo, 'book_id' | 'name' | 'category'>,
  index: number,
  chapterId: string,
): string {
  const genre = slugify(book.category?.[0] ?? '');
  const slug = slugify(book.name);
  return `${BASE}/en/${genre}/${slug}/${index}/${book.book_id}#${chapterId}`;
}

export function parseSearch(res: WcApiResponse<{ list?: WcBookInfo[] }>): SourceSeriesHit[] {
  return (res.data?.list ?? []).map((b) => ({
    title: b.name,
    url: seriesUrl(b),
    cover: b.cover || b.pic || undefined,
  }));
}

export function parseChapters(
  items: WcChapterItem[],
  book: Pick<WcBookInfo, 'book_id' | 'name' | 'category'>,
): SourceChapter[] {
  const seen = new Map<number, SourceChapter>();
  for (const c of items) {
    if (!Number.isFinite(c.index)) continue;
    if (seen.has(c.index)) continue;
    const label = c.name || c.cp_name_info || `Ch. ${c.index}`;
    seen.set(c.index, {
      number: c.index,
      label,
      title: c.cp_name_info && c.cp_name_info !== label ? c.cp_name_info : undefined,
      url: chapterUrl(book, c.index, c.chapter_id),
      date: c.update_time && c.update_time > 0 ? new Date(c.update_time).toISOString() : undefined,
      locked: Boolean(c.is_pay && !c.is_paid),
    });
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

export function parsePages(detail: WcChapterDetail): PageRef[] {
  const base = detail.base_url.endsWith('/') ? detail.base_url : `${detail.base_url}/`;
  return (detail.images ?? []).map((img, i) => {
    const url = /^https?:\/\//.test(img.url) ? img.url : `${base}${img.url.replace(/^\/+/, '')}`;
    const ext = new URL(url).pathname.split('.').pop() || 'webp';
    return {
      url,
      name: `${String(i + 1).padStart(3, '0')}.${ext}`,
      headers: { referer: `${BASE}/` },
      width: img.width && img.width > 0 ? img.width : undefined,
      height: img.height && img.height > 0 ? img.height : undefined,
    };
  });
}

/** Decode Nuxt 3's devalue-serialized `__NUXT_DATA__` payload as a fallback for bare chapter URLs. */
export function parseNuxtChapterPages(html: string): PageRef[] {
  const raw = cheerio.load(html)('#__NUXT_DATA__').text();
  if (!raw) return [];
  const arr = JSON.parse(raw) as unknown[];
  const memo = new Map<number, unknown>();
  const revive = (idx: unknown): unknown => {
    if (typeof idx !== 'number') return idx;
    if (memo.has(idx)) return memo.get(idx);
    const val = arr[idx];
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) {
      if (val.length === 2 && typeof val[0] === 'string' && ['ShallowReactive', 'Reactive', 'Ref', 'Set'].includes(val[0])) {
        const res = revive(val[1]);
        memo.set(idx, res);
        return res;
      }
      const out: unknown[] = [];
      memo.set(idx, out);
      for (const item of val) out.push(revive(item));
      return out;
    }
    const out: Record<string, unknown> = {};
    memo.set(idx, out);
    for (const [k, v] of Object.entries(val)) out[k] = revive(v);
    return out;
  };

  const root = revive(0) as { data?: Record<string, { detail?: WcChapterDetail }> };
  const entry = Object.entries(root.data ?? {}).find(([k]) => k.startsWith('reader-seo-chapter-'))?.[1];
  return entry?.detail ? parsePages(entry.detail) : [];
}

export const webcomics: SourceAdapter = {
  id: 'webcomics',
  name: 'WebComics',
  baseUrl: BASE,
  kind: 'official',
  hosts: ['webcomicsapp.com', 'official-website-api.webcomicsapp.com'],
  rateLimit: { rpm: 30, concurrency: 2 },

  async search(title, http) {
    const res = await http.postJson<WcApiResponse<{ list?: WcBookInfo[] }>>(
      `${API}/api/web/v4/book/search`,
      { word: title, page: 1, size: 20 },
      { cacheMs: 60 * 60_000 },
    );
    return parseSearch(res);
  },

  async getSeries(url, http): Promise<SourceSeries> {
    const bookId = parseBookId(url);
    if (!bookId) throw new Error(`Not a WebComics series or chapter URL: ${url}`);

    const infoRes = await http.postJson<WcApiResponse<WcBookInfo>>(
      `${API}/api/web/v4/book/info`,
      { book_id: bookId },
      { cacheMs: 10 * 60_000 },
    );
    if (infoRes.code !== 1000 || !infoRes.data) {
      throw new Error(`WebComics book ${bookId} not found (${infoRes.msg ?? infoRes.code})`);
    }
    const book = infoRes.data;

    const all: WcChapterItem[] = [];
    for (let page = 1; page <= MAX_CHAPTER_PAGES; page++) {
      const listRes = await http.postJson<WcApiResponse<WcChapterListData>>(
        `${API}/api/web/v4/book/chapter/list`,
        { book_id: bookId, page, size: PAGE_SIZE, sort: 'asc' },
        { cacheMs: 10 * 60_000 },
      );
      if (listRes.code !== 1000 || !listRes.data) break;
      all.push(...(listRes.data.list ?? []));
      if (!listRes.data.pagination?.next) break;
    }

    return {
      title: book.name,
      url: seriesUrl(book),
      altTitles: [],
      cover: book.cover || book.pic || undefined,
      description: book.description || undefined,
      chapters: parseChapters(all, book),
    };
  },

  async getChapterPages(chapter, http) {
    if (chapter.locked) throw new Error(`Chapter ${chapter.number} is paid/locked on WebComics`);
    const bookId = parseBookId(chapter.url);
    const chapterId = new URL(chapter.url).hash.slice(1);
    if (bookId && OBJECT_ID_RE.test(chapterId)) {
      const res = await http.postJson<WcApiResponse<WcChapterDetail>>(
        `${API}/api/web/v4/book/chapter/detail`,
        { book_id: bookId, chapter_id: chapterId },
      );
      if (res.code !== 1000 || !res.data?.images?.length) {
        throw new Error(`Chapter ${chapter.number} has no readable pages (code ${res.code})`);
      }
      return parsePages(res.data);
    }
    const pages = parseNuxtChapterPages(await http.text(chapter.url));
    if (pages.length === 0) throw new Error(`Chapter ${chapter.number} has no readable pages`);
    return pages;
  },
};
