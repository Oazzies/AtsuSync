import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://www.novelstime.com';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a[href^="/novel/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || /^\/novel\/[^/]+\//.test(href)) return;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) return;
    const title = $(el).text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(url);
    const card = $(el).closest('div').parent();
    const img = card.find('img').first();
    const cover = (img.attr('src') ?? img.attr('data-src'))?.trim() || undefined;
    hits.push({ title, url, cover });
  });
  return hits;
}

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const slugPath = new URL(url, BASE).pathname.replace(/\/$/, '');
  const byNumber = new Map<number, SourceChapter>();
  $(`a[href^="${slugPath}/"]`).each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    const seg = href.slice(slugPath.length + 1);
    const numMatch = seg.match(/^(\d+(?:\.\d+)?)(?=-|$)/);
    const number = numMatch ? Number(numMatch[1]) : chapterNumberFrom(label, seg);
    if (number == null || !Number.isFinite(number) || byNumber.has(number)) return;
    byNumber.set(number, { number, label: label || `Chapter ${number}`, url: new URL(href, BASE).href });
  });
  const cover = $('img[src*="/cover/"]').first().attr('src')?.trim()
    || $('meta[property="og:image"]').attr('content')?.trim()
    || undefined;
  return {
    title,
    url,
    altTitles: [],
    cover,
    description: $('meta[property="og:description"]').attr('content')?.trim() || undefined,
    chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
  };
}

export function parseChapterText(html: string, fallbackTitle: string): NovelChapter {
  const $ = cheerio.load(html);
  const box = $('.prose.max-w-none').first().length ? $('.prose.max-w-none').first() : $('.prose').first();
  box.find('script, style, .ads, .adsbygoogle').remove();
  const heading = $('h2, h3').first().text().replace(/\s+/g, ' ').trim();
  return { title: heading || fallbackTitle, html: chapterXhtml($, box) };
}

export const novelstime: SourceAdapter = {
  id: 'novelstime',
  name: 'NovelsTime',
  baseUrl: BASE,
  kind: 'aggregator',
  medium: 'novel',
  hosts: ['novelstime.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const series = parseSeries(await http.text(url, { cacheMs: 10 * 60_000 }), url);
    if (series.chapters.length === 0) series.emptyReason = 'no chapter list found';
    return series;
  },

  async getChapterPages() {
    throw new Error('NovelsTime chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
