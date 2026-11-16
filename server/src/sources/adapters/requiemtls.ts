import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://requiemtls.com';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a[href^="/series/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href === '/series/' || href === '/series') return;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) return;
    const row = $(el).closest('.series-row, .row, article, li, div');
    const title = (row.find('h2, h3, .series-title, .title').first().text() || $(el).attr('title') || $(el).text())
      .replace(/\s+/g, ' ')
      .trim();
    if (!title || /^R\d/.test(title)) return;
    seen.add(url);
    const img = row.find('img').first();
    const cover = (img.attr('src') ?? img.attr('data-src'))?.trim() || undefined;
    hits.push({ title, url, cover });
  });
  return hits;
}

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const slug = new URL(url, BASE).pathname.replace(/^\/series\//, '').replace(/\/$/, '');
  const byNumber = new Map<number, SourceChapter>();
  $(`a[href*="${slug}-"]`).each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    const number = chapterNumberFrom(href, label);
    if (number == null || !Number.isFinite(number) || byNumber.has(number)) return;
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

export function parseChapterText(html: string, fallbackTitle: string): NovelChapter {
  const $ = cheerio.load(html);
  const box = $('.reader-prose').first();
  box.find('script, style, .ads, .adsbygoogle').remove();
  return { title: fallbackTitle, html: chapterXhtml($, box) };
}

export const requiemtls: SourceAdapter = {
  id: 'requiemtls',
  name: 'Requiem Translations',
  baseUrl: BASE,
  kind: 'scanlation',
  medium: 'novel',
  hosts: ['requiemtls.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/series/?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const series = parseSeries(await http.text(url, { cacheMs: 10 * 60_000 }), url);
    if (series.chapters.length === 0) series.emptyReason = 'no chapter list found';
    return series;
  },

  async getChapterPages() {
    throw new Error('Requiem Translations chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
