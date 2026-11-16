import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://mangakatana.com';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('#book_list .item').each((_, el) => {
    const a = $(el).find('.title a').first();
    const href = a.attr('href');
    if (!href) return;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) return;
    const title = a.text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(url);
    const img = $(el).find('img').first();
    const rawCover = (img.attr('data-src') ?? img.attr('src'))?.trim();
    hits.push({ title, url, cover: rawCover ? new URL(rawCover, BASE).href : undefined });
  });
  return hits;
}

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1.heading').first().text().replace(/\s+/g, ' ').trim() || $('h1').first().text().replace(/\s+/g, ' ').trim();
  const byNumber = new Map<number, SourceChapter>();
  $('.chapters table tr a').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    const m = href.match(/\/c(\d+(?:\.\d+)?)/i) ?? label.match(/(\d+(?:\.\d+)?)/);
    const number = m ? Number(m[1]) : NaN;
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
  const m = html.match(/var\s+thzq\s*=\s*\[([^\]]+)\]/);
  const urls: string[] = [];
  if (m) {
    for (const raw of m[1]!.matchAll(/['"](https?:\/\/[^'"]+)['"]/g)) {
      if (!urls.includes(raw[1]!)) urls.push(raw[1]!);
    }
  }
  return urls.map((u, i) => {
    const ext = new URL(u).pathname.split('.').pop()?.toLowerCase() || 'jpg';
    return { url: u, name: `${String(i + 1).padStart(3, '0')}.${ext}`, headers: { referer } };
  });
}

export const mangakatana: SourceAdapter = {
  id: 'mangakatana',
  name: 'MangaKatana',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['mangakatana.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(
      await http.text(`${BASE}/?search=${encodeURIComponent(title)}&search_by=book_name`, { cacheMs: 60 * 60_000, ignoreRobots: true }),
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
