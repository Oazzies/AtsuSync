import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://novelphoenix.com';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('.novel-item a[href*="/novel/"], a[href^="/novel/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || /\/(?:chapter-|chapters)/.test(href)) return;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) return;
    const item = $(el).closest('.novel-item');
    const title = (item.find('h2, h3, h4, .novel-title, .title').first().text() || $(el).attr('title') || $(el).text())
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) return;
    seen.add(url);
    const img = item.length ? item.find('img').first() : $(el).find('img').first();
    const cover = (img.attr('data-src') ?? img.attr('src'))?.trim() || undefined;
    hits.push({ title, url, cover });
  });
  return hits;
}

export function parseChaptersPage(html: string): { chapters: SourceChapter[]; maxPage: number } {
  const $ = cheerio.load(html);
  const chapters: SourceChapter[] = [];
  $('a[href*="/chapter-"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    const number = chapterNumberFrom(href, label);
    if (number == null || !Number.isFinite(number)) return;
    chapters.push({ number, label: label || `Chapter ${number}`, url: new URL(href, BASE).href });
  });
  let maxPage = 1;
  $('a[href*="page="]').each((_, el) => {
    const m = $(el).attr('href')?.match(/[?&]page=(\d+)/);
    if (m) maxPage = Math.max(maxPage, Number(m[1]));
  });
  return { chapters, maxPage };
}

export function parseSeries(html: string, url: string, chaptersHtml?: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const byNumber = new Map<number, SourceChapter>();
  for (const c of parseChaptersPage(chaptersHtml ?? html).chapters) {
    if (!byNumber.has(c.number)) byNumber.set(c.number, c);
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

export function parseChapterText(html: string, fallbackTitle: string): NovelChapter {
  const $ = cheerio.load(html);
  const box = $('#content').first().length ? $('#content').first() : $('.chapter-content').first();
  box.find('script, style, .ads, .adsbygoogle, .content-nav, .chapter-nav').remove();
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim() || fallbackTitle;
  return { title, html: chapterXhtml($, box) };
}

export const novelphoenix: SourceAdapter = {
  id: 'novelphoenix',
  name: 'Novel Phoenix',
  baseUrl: BASE,
  kind: 'aggregator',
  medium: 'novel',
  hosts: ['novelphoenix.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search?keyword=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const clean = url.replace(/\/chapters.*$/, '').replace(/\/$/, '');
    const html = await http.text(clean, { cacheMs: 10 * 60_000 });
    const firstChHtml = await http.text(`${clean}/chapters?page=1`, { cacheMs: 10 * 60_000 });
    const series = parseSeries(html, clean, firstChHtml);
    const { maxPage } = parseChaptersPage(firstChHtml);
    const byNumber = new Map(series.chapters.map((c) => [c.number, c]));
    for (let page = 2; page <= maxPage; page++) {
      const pageHtml = await http.text(`${clean}/chapters?page=${page}`, { cacheMs: 10 * 60_000 });
      for (const c of parseChaptersPage(pageHtml).chapters) {
        if (!byNumber.has(c.number)) byNumber.set(c.number, c);
      }
    }
    series.chapters = [...byNumber.values()].sort((a, b) => a.number - b.number);
    if (series.chapters.length === 0) series.emptyReason = 'no chapter list found';
    return series;
  },

  async getChapterPages() {
    throw new Error('Novel Phoenix chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
