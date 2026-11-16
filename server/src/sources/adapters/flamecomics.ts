import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://flamecomics.xyz';
const CDN = 'https://cdn.flamecomics.xyz/uploads/images/series';

interface FlameSeries {
  series_id: number;
  title: string;
  altTitles?: string[];
  description?: string;
  cover?: string;
}

interface FlameChapter {
  chapter: string;
  title?: string;
  token: string;
  release_date?: number;
}

interface FlameImage {
  name: string;
  width?: number;
  height?: number;
}

interface FlameNextData {
  props?: {
    pageProps?: {
      series?: FlameSeries | FlameSeries[];
      chapters?: FlameChapter[];
      chapter?: {
        series_id?: number;
        token?: string;
        images?: Record<string, FlameImage>;
      };
    };
  };
}

function nextData(html: string): FlameNextData {
  const $ = cheerio.load(html);
  const raw = $('#__NEXT_DATA__').html();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as FlameNextData;
  } catch {
    return {};
  }
}

export function parseBrowse(html: string, query: string): SourceSeriesHit[] {
  const list = nextData(html).props?.pageProps?.series;
  if (!Array.isArray(list)) return [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return list
    .filter((s) => {
      const hay = [s.title, ...(s.altTitles ?? [])].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, 15)
    .map((s) => ({
      title: s.title,
      url: `${BASE}/series/${s.series_id}`,
      cover: s.cover ? `${CDN}/${s.series_id}/${s.cover}` : undefined,
    }));
}

export function parseSeries(html: string, url: string): SourceSeries {
  const pp = nextData(html).props?.pageProps;
  const s = !Array.isArray(pp?.series) ? pp?.series : undefined;
  if (!s?.series_id || !s.title) throw new Error(`Not a Flame Comics series page: ${url}`);
  const byNumber = new Map<number, SourceChapter>();
  for (const ch of pp?.chapters ?? []) {
    const number = Number(ch.chapter);
    if (!Number.isFinite(number) || !ch.token || byNumber.has(number)) continue;
    byNumber.set(number, {
      number,
      label: ch.title?.trim() ? `Chapter ${number}: ${ch.title.trim()}` : `Chapter ${number}`,
      url: `${BASE}/series/${s.series_id}/${ch.token}`,
      date: ch.release_date ? new Date(ch.release_date * 1000).toISOString() : undefined,
    });
  }
  return {
    title: s.title.trim(),
    url: `${BASE}/series/${s.series_id}`,
    altTitles: (s.altTitles ?? []).map((t) => t.trim()).filter((t) => t && t !== s.title),
    cover: s.cover ? `${CDN}/${s.series_id}/${s.cover}` : undefined,
    description: s.description?.trim() || undefined,
    chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
  };
}

export function parsePages(html: string, referer: string): PageRef[] {
  const ch = nextData(html).props?.pageProps?.chapter;
  if (!ch?.series_id || !ch.token || !ch.images) return [];
  return Object.entries(ch.images)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, img], i) => {
      const ext = img.name.split('.').pop()?.toLowerCase() || 'jpg';
      return {
        url: `${CDN}/${ch.series_id}/${ch.token}/${img.name}`,
        name: `${String(i + 1).padStart(3, '0')}.${ext}`,
        width: img.width,
        height: img.height,
        headers: { referer },
      };
    });
}

export const flamecomics: SourceAdapter = {
  id: 'flamecomics',
  name: 'Flame Comics',
  baseUrl: BASE,
  kind: 'scanlation',
  hosts: ['flamecomics.xyz'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseBrowse(await http.text(`${BASE}/browse`, { cacheMs: 60 * 60_000 }), title);
  },

  async getSeries(url, http) {
    return parseSeries(await http.text(url, { cacheMs: 10 * 60_000 }), url);
  },

  async getChapterPages(chapter, http) {
    const pages = parsePages(await http.text(chapter.url), chapter.url);
    if (pages.length === 0) throw new Error(`No images found on ${chapter.url}`);
    return pages;
  },
};
