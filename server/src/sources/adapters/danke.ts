import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://danke.moe';

/** "/read/manga/xdress-underwear/" → "xdress-underwear". */
export const slugFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/read\/manga\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

/** "/read/manga/xdress-underwear/0/1/" → { slug: "xdress-underwear", chapterKey: "0" }. */
export const chapterRefFromUrl = (url: string): { slug: string; chapterKey: string } | null => {
  try {
    const m = new URL(url).pathname.match(/^\/read\/manga\/([^/]+)\/([^/]+)/);
    return m ? { slug: m[1]!, chapterKey: m[2]! } : null;
  } catch {
    return null;
  }
};

export interface DankeSeriesEntry {
  slug: string;
  title?: string;
  description?: string;
  cover?: string;
}

export interface DankeChapterEntry {
  volume?: string;
  title?: string;
  folder: string;
  groups: Record<string, string[]>;
  release_date?: Record<string, number>;
}

export interface DankeSeriesJson {
  slug: string;
  title: string;
  description?: string;
  cover?: string;
  chapters: Record<string, DankeChapterEntry>;
}

export function searchAllSeries(all: Record<string, DankeSeriesEntry>, query: string): SourceSeriesHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SourceSeriesHit[] = [];
  for (const [title, entry] of Object.entries(all)) {
    const display = entry.title || title;
    if (display.toLowerCase().includes(q) || entry.slug.toLowerCase().includes(q)) {
      hits.push({
        title: display,
        url: `${BASE}/read/manga/${entry.slug}/`,
        cover: entry.cover ? new URL(entry.cover, BASE).href : undefined,
      });
    }
  }
  return hits.slice(0, 25);
}

export function parseSeriesJson(data: DankeSeriesJson): SourceSeries {
  const seriesUrl = `${BASE}/read/manga/${data.slug}/`;
  const chapters: SourceChapter[] = [];
  for (const [key, ch] of Object.entries(data.chapters ?? {})) {
    const number = Number(key);
    if (!Number.isFinite(number)) continue;
    const firstTs = Object.values(ch.release_date ?? {})[0];
    const date = typeof firstTs === 'number' && firstTs > 0 ? new Date(firstTs * 1000).toISOString() : undefined;
    chapters.push({
      number,
      label: ch.title ? `${key} — ${ch.title}` : `Chapter ${key}`,
      url: `${seriesUrl}${key}/1/`,
      title: ch.title || undefined,
      date,
      locked: false,
    });
  }
  chapters.sort((a, b) => a.number - b.number);
  const cleanDesc = data.description?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || undefined;
  return {
    title: data.title,
    url: seriesUrl,
    altTitles: [],
    cover: data.cover ? new URL(data.cover, BASE).href : undefined,
    description: cleanDesc,
    chapters,
  };
}

export function parseChapterPages(data: DankeSeriesJson, chapterKey: string, referer: string): PageRef[] {
  const ch = data.chapters?.[chapterKey];
  if (!ch) return [];
  const groupEntry = Object.entries(ch.groups ?? {})[0];
  if (!groupEntry) return [];
  const [groupId, files] = groupEntry;
  return files.map((file, i) => {
    const url = `${BASE}/media/manga/${data.slug}/chapters/${ch.folder}/${groupId}/${file}`;
    const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() || 'png';
    return {
      url,
      name: `${String(i + 1).padStart(3, '0')}.${ext}`,
      headers: { referer },
    };
  });
}

export const danke: SourceAdapter = {
  id: 'danke',
  name: 'Danke fürs Lesen',
  baseUrl: BASE,
  kind: 'scanlation',
  hosts: ['danke.moe'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    const all = await http.json<Record<string, DankeSeriesEntry>>(`${BASE}/api/get_all_series/`, { cacheMs: 60 * 60_000 });
    return searchAllSeries(all, title);
  },

  async getSeries(url, http) {
    const slug = slugFromUrl(url);
    if (!slug) throw new Error(`Not a Danke fürs Lesen series URL: ${url}`);
    const data = await http.json<DankeSeriesJson>(`${BASE}/api/series/${slug}/`, { cacheMs: 10 * 60_000 });
    return parseSeriesJson(data);
  },

  async getChapterPages(chapter, http) {
    const ref = chapterRefFromUrl(chapter.url);
    if (!ref) throw new Error(`Not a Danke fürs Lesen chapter URL: ${chapter.url}`);
    const data = await http.json<DankeSeriesJson>(`${BASE}/api/series/${ref.slug}/`, { cacheMs: 10 * 60_000 });
    return parseChapterPages(data, ref.chapterKey, chapter.url);
  },
};
