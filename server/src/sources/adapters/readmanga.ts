import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://readmanga.cc';

/** "/manga/blue-lock-3" → "blue-lock-3". */
export const slugFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/manga\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

const abs = (href: string) => new URL(href, BASE).href;

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a[href*="/manga/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const url = abs(href);
    if (seen.has(url)) return;
    const title = ($(el).attr('title') || $(el).find('h2, h3').first().text() || $(el).text()).trim();
    if (!title) return;
    seen.add(url);
    const cover = $(el).closest('div').find('img').first().attr('src');
    hits.push({ title, url, cover: cover ? abs(cover) : undefined });
  });
  return hits;
}

const chapterNumber = (href: string): number | null => {
  const m = href.match(/\/chapter-(\d+(?:\.\d+)?)\/?$/i);
  return m ? Number(m[1]) : null;
};

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim() || slugFromUrl(url) || url;
  const cover = $('meta[property="og:image"]').attr('content') || undefined;
  const description = $('meta[name="description"]').attr('content')?.trim() || undefined;

  const byNumber = new Map<number, SourceChapter>();
  $('a[href*="/read/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const number = chapterNumber(href);
    if (number == null || !Number.isFinite(number) || byNumber.has(number)) return;
    byNumber.set(number, {
      number,
      label: `Chapter ${number}`,
      url: abs(href),
      locked: false,
    });
  });

  return {
    title,
    url,
    altTitles: [],
    cover: cover ? abs(cover) : undefined,
    description,
    chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
  };
}

export function parsePages(html: string, referer: string): PageRef[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const urls: string[] = [];
  $('img[alt*=" page "]').each((_, el) => {
    const raw = ($(el).attr('data-src') ?? $(el).attr('src'))?.trim();
    if (!raw) return;
    const u = abs(raw);
    if (/^https?:\/\//.test(u) && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  });
  return urls.map((u, i) => {
    const ext = new URL(u).pathname.split('.').pop()?.toLowerCase() || 'jpg';
    return {
      url: u,
      name: `${String(i + 1).padStart(3, '0')}.${ext}`,
      headers: { referer },
    };
  });
}

export const readmanga: SourceAdapter = {
  id: 'readmanga',
  name: 'ReadManga',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['readmanga.cc'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const slug = slugFromUrl(url);
    if (!slug) throw new Error(`Not a ReadManga series URL: ${url}`);
    return parseSeries(await http.text(`${BASE}/manga/${slug}`, { cacheMs: 10 * 60_000 }), `${BASE}/manga/${slug}`);
  },

  async getChapterPages(chapter, http) {
    return parsePages(await http.text(chapter.url), chapter.url);
  },
};
