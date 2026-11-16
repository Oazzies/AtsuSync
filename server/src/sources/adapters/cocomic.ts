import * as cheerio from 'cheerio';
import { parseMadaraSearch } from '../madara.ts';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries } from '../types.ts';

const BASE = 'https://cocomic.co';

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const byNumber = new Map<number, SourceChapter>();
  $('a[href*="/chapter-"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    const m = href.match(/chapter-(\d+(?:[.-]\d+)?)/i) ?? label.match(/(\d+(?:\.\d+)?)/);
    const number = m ? Number(m[1]!.replace('-', '.')) : NaN;
    if (!Number.isFinite(number)) return;
    const existing = byNumber.get(number);
    if (existing && !/read\s+(?:first|now)/i.test(existing.label)) return;
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
  $('.asura-stream-images img, .reading-content img').each((_, el) => {
    const raw = ($(el).attr('data-src') ?? $(el).attr('src'))?.trim();
    if (!raw || raw.startsWith('data:')) return;
    const abs = new URL(raw, BASE).href;
    if (!seen.has(abs)) {
      seen.add(abs);
      urls.push(abs);
    }
  });
  return urls.map((u, i) => {
    const ext = new URL(u).pathname.split('.').pop()?.toLowerCase() || 'jpg';
    return { url: u, name: `${String(i + 1).padStart(3, '0')}.${ext}`, headers: { referer } };
  });
}

export const cocomic: SourceAdapter = {
  id: 'cocomic',
  name: 'Cocomic',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['cocomic.co'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseMadaraSearch(
      await http.text(`${BASE}/?s=${encodeURIComponent(title)}&post_type=wp-manga`, { cacheMs: 60 * 60_000, ignoreRobots: true }),
      BASE,
    );
  },

  async getSeries(url, http) {
    return parseSeries(await http.text(url, { cacheMs: 10 * 60_000, ignoreRobots: true }), url);
  },

  async getChapterPages(chapter, http) {
    const pages = parsePages(await http.text(chapter.url, { ignoreRobots: true }), chapter.url);
    if (pages.length === 0) throw new Error(`No images found on ${chapter.url}`);
    return pages;
  },
};
