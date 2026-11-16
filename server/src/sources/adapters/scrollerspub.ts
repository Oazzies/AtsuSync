import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://www.scrollerspub.com';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a[href*="/novel/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) return;
    const title = ($(el).attr('title') ?? $(el).text()).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(url);
    const card = $(el).closest('div, li, article');
    const img = card.find('img').first();
    const rawCover = (img.attr('data-src') ?? img.attr('src'))?.trim();
    hits.push({ title, url, cover: rawCover ? new URL(rawCover, BASE).href : undefined });
  });
  return hits;
}

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const byNumber = new Map<number, SourceChapter>();
  $('a[href*="/read/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    const number = chapterNumberFrom(label, href) ?? byNumber.size + 1;
    if (byNumber.has(number)) return;
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

export function parseText(html: string, fallbackTitle: string): NovelChapter {
  const $ = cheerio.load(html);
  const container = $('#chapter-content, .chapter-c').first();
  const heading = $('h1, h2').first().text().replace(/\s+/g, ' ').trim();
  return { title: heading || fallbackTitle, html: chapterXhtml($, container) };
}

export const scrollerspub: SourceAdapter = {
  id: 'scrollerspub',
  name: 'ScrollersPub',
  baseUrl: BASE,
  kind: 'aggregator',
  medium: 'novel',
  hosts: ['scrollerspub.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000, ignoreRobots: true }));
  },

  async getSeries(url, http) {
    return parseSeries(await http.text(url, { cacheMs: 10 * 60_000, ignoreRobots: true }), url);
  },

  async getChapterText(chapter, http) {
    return parseText(await http.text(chapter.url, { ignoreRobots: true }), chapter.label);
  },

  async getChapterPages() {
    throw new Error('ScrollersPub is a novel source; use getChapterText');
  },
};
