import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://mangacherri.com';

/** "/title/too-soon-to-fall-in-love-with-a-god" → "too-soon-to-fall-in-love-with-a-god". */
export const slugFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/title\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

const abs = (href: string) => new URL(href, BASE).href;

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a.cherri-list-card__cover[href*="/title/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const url = abs(href);
    if (seen.has(url)) return;
    const img = $(el).find('img').first();
    const rawAlt = img.attr('alt')?.replace(/^Cover of\s+/i, '').trim();
    const title = ($(el).closest('article').find('h2, h3').first().text() || rawAlt || '').trim();
    if (!title) return;
    seen.add(url);
    const coverSrc = img.attr('src');
    hits.push({ title, url, cover: coverSrc ? abs(coverSrc) : undefined });
  });
  return hits;
}

const chapterNumber = (label: string): number | null => {
  const explicit = label.match(/(?:chapter|ch\.?|episode|ep\.?)\s*#?(\d+(?:\.\d+)?)/i)?.[1];
  if (explicit) return Number(explicit);
  const fallback = label.match(/(\d+(?:\.\d+)?)/)?.[1];
  if (fallback) return Number(fallback);
  if (/\b(prologue|oneshot|one-shot)\b/i.test(label)) return 0;
  return null;
};

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim() || slugFromUrl(url) || url;
  const cover = $('meta[property="og:image"]').attr('content') || undefined;
  const description = $('meta[name="description"]').attr('content')?.trim() || undefined;

  const byNumber = new Map<number, SourceChapter>();
  $('a.cherri-chapter-row[href*="/read/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).find('strong').first().clone().children().remove().end().text().trim() || $(el).find('strong').first().text().trim();
    const number = chapterNumber(label);
    if (number == null || !Number.isFinite(number) || byNumber.has(number)) return;
    const rawDate = $(el).find('time').attr('datetime');
    const date = rawDate && !Number.isNaN(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : undefined;
    byNumber.set(number, {
      number,
      label: label || `Chapter ${number}`,
      url: abs(href),
      date,
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
  $('[data-reader-page] img').each((_, el) => {
    const raw = $(el).attr('src') ?? $(el).attr('data-src');
    if (!raw) return;
    const u = abs(raw);
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  });
  return urls.map((u, i) => {
    const ext = new URL(u).pathname.split('.').pop()?.toLowerCase() || 'webp';
    return {
      url: u,
      name: `${String(i + 1).padStart(3, '0')}.${ext}`,
      headers: { referer },
    };
  });
}

export const mangacherri: SourceAdapter = {
  id: 'mangacherri',
  name: 'MangaCherri',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['mangacherri.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/manga?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const slug = slugFromUrl(url);
    if (!slug) throw new Error(`Not a MangaCherri series URL: ${url}`);
    return parseSeries(await http.text(`${BASE}/title/${slug}`, { cacheMs: 10 * 60_000 }), `${BASE}/title/${slug}`);
  },

  async getChapterPages(chapter, http) {
    return parsePages(await http.text(chapter.url), chapter.url);
  },
};
