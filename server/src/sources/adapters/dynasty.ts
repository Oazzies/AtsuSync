import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://dynasty-scans.com';

/** "/series/bloom_into_you" → "bloom_into_you". */
export const slugFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/series\/([^/.]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

/** "/chapters/bloom_into_you_ch01" → "bloom_into_you_ch01". */
export const chapterSlugFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/chapters\/([^/.]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a.name[href^="/series/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) return;
    const title = $(el).text().trim();
    if (!title) return;
    seen.add(url);
    hits.push({ title, url });
  });
  return hits;
}

export interface DynastySeriesJson {
  name: string;
  permalink: string;
  cover?: string | null;
  description?: string | null;
  aliases?: string[];
  taggings?: Array<{
    title?: string;
    permalink?: string;
    released_on?: string;
    header?: string;
  }>;
}

export interface DynastyChapterJson {
  pages: Array<{ name: string; url: string }>;
}

const chapterNumber = (title: string, permalink: string): number | null => {
  const fromTitle = title.match(/(?:chapter|ch\.?|episode|ep\.?)\s*#?(\d+(?:\.\d+)?)/i)?.[1];
  if (fromTitle) return Number(fromTitle);
  const fromSlug = permalink.match(/_ch(\d+(?:\.\d+)?)/i)?.[1];
  if (fromSlug) return Number(fromSlug);
  const fallback = title.match(/^(\d+(?:\.\d+)?)\b/)?.[1];
  if (fallback) return Number(fallback);
  if (/\b(prologue|oneshot|one-shot|extra|omake)\b/i.test(title)) return 0;
  return null;
};

export function parseSeriesJson(data: DynastySeriesJson, url: string): SourceSeries {
  const byNumber = new Map<number, SourceChapter>();
  for (const t of data.taggings ?? []) {
    if (!t.permalink || !t.title) continue;
    const number = chapterNumber(t.title, t.permalink);
    if (number == null || !Number.isFinite(number) || byNumber.has(number)) continue;
    const date = t.released_on && !Number.isNaN(Date.parse(t.released_on)) ? new Date(t.released_on).toISOString() : undefined;
    byNumber.set(number, {
      number,
      label: t.title.trim(),
      url: `${BASE}/chapters/${t.permalink}`,
      date,
      locked: false,
    });
  }

  return {
    title: data.name,
    url,
    altTitles: (data.aliases ?? []).filter((a) => a && a !== data.name),
    cover: data.cover ? new URL(data.cover, BASE).href : undefined,
    description: data.description?.trim() || undefined,
    chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
  };
}

export function parseChapterJson(data: DynastyChapterJson, referer: string): PageRef[] {
  return (data.pages ?? []).map((p, i) => {
    const url = new URL(p.url, BASE).href;
    const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() || 'png';
    return {
      url,
      name: `${String(i + 1).padStart(3, '0')}.${ext}`,
      headers: { referer },
    };
  });
}

export const dynasty: SourceAdapter = {
  id: 'dynasty',
  name: 'Dynasty Reader',
  baseUrl: BASE,
  kind: 'scanlation',
  hosts: ['dynasty-scans.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    const url = `${BASE}/search?q=${encodeURIComponent(title)}&classes%5B%5D=Series`;
    return parseSearch(await http.text(url, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const slug = slugFromUrl(url);
    if (!slug) throw new Error(`Not a Dynasty Reader series URL: ${url}`);
    const canonical = `${BASE}/series/${slug}`;
    const data = await http.json<DynastySeriesJson>(`${canonical}.json`, { cacheMs: 10 * 60_000 });
    return parseSeriesJson(data, canonical);
  },

  async getChapterPages(chapter, http) {
    const slug = chapterSlugFromUrl(chapter.url);
    if (!slug) throw new Error(`Not a Dynasty Reader chapter URL: ${chapter.url}`);
    const data = await http.json<DynastyChapterJson>(`${BASE}/chapters/${slug}.json`);
    return parseChapterJson(data, chapter.url);
  },
};
