import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://mangack.com';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a[href*="/manga/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) return;
    const title = $(el).text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(url);
    const card = $(el).closest('article, .item, .post, li, div');
    const img = card.find('img').first();
    const cover = (img.attr('data-src') ?? img.attr('src'))?.trim() || undefined;
    hits.push({ title, url, cover });
  });
  return hits;
}

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const byNumber = new Map<number, SourceChapter>();
  $('a[href*="/chapter/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    const m = href.match(/chapter-(\d+(?:[.-]\d+)?)/i) ?? label.match(/(\d+(?:\.\d+)?)/);
    const number = m ? Number(m[1]!.replace('-', '.')) : NaN;
    if (!Number.isFinite(number) || byNumber.has(number)) return;
    byNumber.set(number, { number, label: label || `Chapter ${number}`, url: new URL(href, BASE).href });
  });
  return {
    title,
    url,
    altTitles: [],
    cover: $('meta[property="og:image"]').attr('content')?.trim() || undefined,
    description: $('meta[property="og:description"]').attr('content')?.trim() || undefined,
    chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
  };
}

export function parsePages(html: string, referer: string): PageRef[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const urls: string[] = [];
  $('.separator img, .reading-content img, #readerarea img').each((_, el) => {
    const raw = ($(el).attr('data-src') ?? $(el).attr('src'))?.trim();
    if (!raw || raw.startsWith('data:')) return;
    const abs = new URL(raw, BASE).href;
    if (!seen.has(abs)) {
      seen.add(abs);
      urls.push(abs);
    }
  });
  return urls.map((u, i) => {
    const ext = new URL(u).pathname.split('.').pop()?.toLowerCase() || 'webp';
    return { url: u, name: `${String(i + 1).padStart(3, '0')}.${ext}`, headers: { referer } };
  });
}

export const mangack: SourceAdapter = {
  id: 'mangack',
  name: 'mangack',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['mangack.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/?s=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
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
