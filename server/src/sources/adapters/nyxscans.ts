import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries } from '../types.ts';

const BASE = 'https://nyxscans.com';

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const slugPath = new URL(url, BASE).pathname.replace(/\/$/, '');
  const byNumber = new Map<number, SourceChapter>();
  $(`a[href^="${slugPath}/chapter-"]`).each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const m = href.match(/\/chapter-(\d+(?:[.-]\d+)?)/i);
    const number = m ? Number(m[1]!.replace('-', '.')) : NaN;
    if (!Number.isFinite(number) || byNumber.has(number)) return;
    byNumber.set(number, { number, label: `Chapter ${number}`, url: new URL(href, BASE).href });
  });
  const nums = [...byNumber.keys()].filter((n) => Number.isInteger(n));
  const minNum = nums.length ? Math.min(...nums) : 0;
  const maxNum = nums.length ? Math.max(...nums) : 0;
  if (maxNum > byNumber.size && minNum <= 1) {
    for (let n = minNum; n <= maxNum; n++) {
      if (!byNumber.has(n)) byNumber.set(n, { number: n, label: `Chapter ${n}`, url: `${BASE}${slugPath}/chapter-${n}` });
    }
  }
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
  $('img[src*="/upload/series/"], img[data-src*="/upload/series/"]').each((_, el) => {
    const raw = ($(el).attr('data-src') ?? $(el).attr('src'))?.trim();
    if (!raw || raw.startsWith('data:') || raw.includes('/featured/')) return;
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

export const nyxscans: SourceAdapter = {
  id: 'nyxscans',
  name: 'Nyx Scans',
  baseUrl: BASE,
  kind: 'scanlation',
  hosts: ['nyxscans.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async getSeries(url, http) {
    return parseSeries(await http.text(url, { cacheMs: 10 * 60_000 }), url);
  },

  async getChapterPages(chapter, http) {
    const pages = parsePages(await http.text(chapter.url), chapter.url);
    if (pages.length === 0) throw new Error(`No images found on ${chapter.url}`);
    return pages;
  },
};
